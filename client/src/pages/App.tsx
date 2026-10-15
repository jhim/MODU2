import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/auth';
import { api, setAccessTokenProvider, type ContentListResponse, type ContentSet, type SourceMode } from '../lib/api';
import type { Flashcard, Suggestion } from '../../../shared/schemas/index';
import { AuthPanel } from '../components/AuthPanel';
import { ContentEditor } from '../components/ContentEditor';
import { ImportPanel } from '../components/ImportPanel';
import { Button, Card, Input } from '../components/ui';

type Screen = 'home' | 'suggestions' | 'generating' | 'study' | 'library' | 'editor' | 'import' | 'auth';
type Draft = { title: string; cards: Flashcard[]; sourceMode: SourceMode; issues: { row: number; message: string }[]; reviewIndexes?: number[]; aiUsageSessionId?: string; aiUsageSessionToken?: string };
type SaveDraft = { draft: Draft; id?: string; expectedUpdatedAt?: string };
export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [session, setSession] = useState<Session | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentSet[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [message, setMessage] = useState('');
  const [refinement, setRefinement] = useState('');
  const [originalRequest, setOriginalRequest] = useState('');
  const [aiUsageSessionId, setAiUsageSessionId] = useState<string | null>(null);
  const [aiUsageSessionToken, setAiUsageSessionToken] = useState<string | null>(null);
  const [activeSet, setActiveSet] = useState<ContentSet | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'new-password'>('login');
  const [listQuery, setListQuery] = useState('');
  const [listSort, setListSort] = useState<'newest' | 'name'>('newest');
  const [listScope, setListScope] = useState<'all' | 'mine'>('all');
  const [listPage, setListPage] = useState(1);
  const [listData, setListData] = useState<ContentListResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<ContentSet | null>(null);
  const [pendingSave, setPendingSave] = useState<SaveDraft | null>(null);
  const searchSequence = useRef(0);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === 'PASSWORD_RECOVERY') { setAuthMode('new-password'); setScreen('auth'); }
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => { setAccessTokenProvider(() => session?.access_token ?? null); }, [session]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const sequence = ++searchSequence.current;
    const timer = window.setTimeout(async () => {
      try { const data = await api.search(query.trim()); if (sequence === searchSequence.current) setResults(data.results); }
      catch { if (sequence === searchSequence.current) setResults([]); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (screen !== 'library') return;
    let current = true;
    setBusy(true);
    api.list({ q: listQuery, sort: listSort, page: listPage, page_size: 20, scope: listScope })
      .then(data => { if (current) setListData(data); })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : '목록을 불러오지 못했습니다.'); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [screen, listQuery, listSort, listPage, listScope, session]);

  useEffect(() => {
    if (!session || !pendingSave) return;
    const save = pendingSave;
    setPendingSave(null);
    void persistDraft(save);
  }, [session, pendingSave]);

  async function persistDraft(input: SaveDraft) {
    setBusy(true); setError('');
    try {
      const set = input.id
        ? await api.update(input.id, { title: input.draft.title, cards: input.draft.cards,
            source_mode: input.draft.sourceMode, expected_updated_at: input.expectedUpdatedAt! })
        : await api.createImported({ title: input.draft.title, cards: input.draft.cards, source_mode: input.draft.sourceMode,
            ...(input.draft.aiUsageSessionId ? { ai_usage_session_id: input.draft.aiUsageSessionId,
              ai_usage_session_token: input.draft.aiUsageSessionToken } : {}) });
      setActiveSet(set); setCardIndex(0); setFlipped(false); setEditing(null); setDraft(null); setScreen('study');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'); setScreen('editor'); }
    finally { setBusy(false); }
  }

  async function recommend(refine = '', subjectOverride?: string) {
    const subject = subjectOverride ?? (originalRequest || query.trim());
    if (!subject) { setError('먼저 학습하고 싶은 주제를 입력해 주세요.'); return; }
    const previous = subjectOverride ? [] : suggestions;
    const reuseSession = !subjectOverride && screen === 'suggestions' && aiUsageSessionId && aiUsageSessionToken;
    setError(''); setBusy(true); setOriginalRequest(subject); setSuggestions(previous); setShowResults(false);
    try {
      const data = await api.suggestions({ original_request: subject, refinement_request: refine, previous_suggestions: previous,
        ...(reuseSession ? { ai_usage_session_id: aiUsageSessionId, ai_usage_session_token: aiUsageSessionToken } : {}) });
      setAiUsageSessionId(data.ai_usage_session_id); setAiUsageSessionToken(data.ai_usage_session_token); setSuggestions(data.suggestions); setMessage(data.message); setRefinement(''); setScreen('suggestions');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '추천을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function openSet(id: string) {
    setBusy(true); setError(''); setShowResults(false);
    try { const set = await api.get(id); setActiveSet(set); setCardIndex(0); setFlipped(false); setScreen('study'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '콘텐츠를 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function createSet(suggestion: Suggestion) {
    setError(''); setScreen('generating');
    try {
      const set = await api.create({ original_request: originalRequest, selected_topic: suggestion.title,
        learning_goal: suggestion.learning_goal, client_request_id: crypto.randomUUID(),
        ...(aiUsageSessionId && aiUsageSessionToken ? { ai_usage_session_id: aiUsageSessionId, ai_usage_session_token: aiUsageSessionToken } : {}) });
      const complete = set.cards ? set : await api.get(set.id);
      setActiveSet(complete); setCardIndex(0); setFlipped(false); setScreen('study');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '카드 생성에 실패했습니다.'); setScreen('suggestions'); }
  }
  function moveCard(delta: number) {
    const last = (activeSet?.cards?.length ?? 0) - 1;
    setCardIndex(index => Math.max(0, Math.min(last, index + delta))); setFlipped(false);
  }
  function goHome() { setScreen('home'); setActiveSet(null); setError(''); setShowResults(false); setAiUsageSessionId(null); setAiUsageSessionToken(null); }
  function openLibrary(scope: 'all' | 'mine' = 'all') {
    setError('');
    if (scope === 'mine' && !session) { setScreen('auth'); setAuthMode('login'); setListScope('mine'); return; }
    setListScope(scope); setListPage(1); setScreen('library');
  }
  function openNewImport() { setDraft(null); setEditing(null); setScreen('import'); }
  function startEdit(set: ContentSet) { setEditing(set); setDraft({ title: set.title, cards: set.cards ?? [], sourceMode: set.source_mode ?? 'AI', issues: [] }); setScreen('editor'); }
  async function saveEditor(input: { title: string; cards: Flashcard[]; sourceMode: SourceMode; expectedUpdatedAt?: string }) {
    const next: Draft = { ...input, issues: draft?.issues ?? [], reviewIndexes: draft?.reviewIndexes };
    if (!session) { setDraft(next); setPendingSave({ draft: next, id: editing?.id, expectedUpdatedAt: input.expectedUpdatedAt }); setAuthMode('login'); setScreen('auth'); return; }
    if (editing?.id) await persistDraft({ draft: next, id: editing.id, expectedUpdatedAt: input.expectedUpdatedAt });
    else await persistDraft({ draft: next });
  }
  function onImportReady(value: { title: string; cards: Flashcard[]; sourceMode: 'PHOTO' | 'TEXT' | 'EXCEL'; issues: { row: number; message: string }[]; reviewIndexes?: number[]; aiUsageSessionId?: string; aiUsageSessionToken?: string }) {
    setDraft({ title: value.title, cards: value.cards, sourceMode: value.sourceMode, issues: value.issues,
      reviewIndexes: value.reviewIndexes, aiUsageSessionId: value.aiUsageSessionId, aiUsageSessionToken: value.aiUsageSessionToken });
    setEditing(null); setScreen('editor');
  }
  async function reuploadExisting(file: File, currentTitle: string) {
    if (!editing?.id) throw new Error('수정할 콘텐츠가 선택되지 않았습니다.');
    const suffix = file.name.toLocaleLowerCase();
    let parsed: { cards: Flashcard[]; issues: { row: number; message: string }[] }, mode: 'TEXT' | 'EXCEL';
    if (suffix.endsWith('.txt')) {
      mode = 'TEXT'; const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      parsed = await api.parseText(text);
    } else if (suffix.endsWith('.xlsx')) {
      mode = 'EXCEL'; if (file.size > 5 * 1024 * 1024) throw new Error('Excel 파일은 5MB 이하만 업로드할 수 있습니다.');
      const inspected = await api.inspectExcel(file); const sheet = inspected.sheets[0];
      if (!sheet) throw new Error('시트가 없습니다.');
      parsed = await api.parseExcel(file, sheet.name);
    } else throw new Error('TXT 또는 XLSX 파일을 선택해 주세요.');
    const proposed = { title: currentTitle, cards: parsed.cards, source_mode: mode };
    const preview = await api.importPreview(editing.id, proposed);
    if (editing.updated_at && preview.current.updated_at !== editing.updated_at) throw new Error('콘텐츠가 다른 곳에서 변경되었습니다. 다시 불러와 주세요.');
    return { title: preview.current.title, cards: preview.proposed.cards, currentCards: preview.current.cards, sourceMode: mode, issues: parsed.issues };
  }
  async function downloadSet(id: string, format: 'txt' | 'xlsx') {
    try {
      const blob = await api.download(id, format); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'modu2-cards.' + format;
      anchor.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '다운로드하지 못했습니다.'); }
  }
  async function deleteSet(id: string) {
    if (!window.confirm('이 콘텐츠와 카드가 모두 삭제됩니다. 삭제할까요?')) return;
    try { await api.delete(id); setListPage(1); setListData(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '삭제하지 못했습니다.'); }
  }
  async function logout() { await supabase?.auth.signOut(); setSession(null); if (listScope === 'mine') setScreen('home'); }
  const name = session?.user.email?.split('@')[0] ?? '';

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={goHome} aria-label="MODU2 홈으로"><span className="brand-mark"><span /><span /></span><span>MODU<span className="brand-two">2</span></span></button>
      <nav className="main-nav" aria-label="주 메뉴">
        <button className={screen === 'home' ? 'active' : ''} onClick={goHome}>만들기</button>
        <button className={screen === 'library' ? 'active' : ''} onClick={() => openLibrary('all')}>학습 콘텐츠 목록</button>
      </nav>
      <div className="account-nav">{session ? <><button onClick={() => openLibrary('mine')}>내 콘텐츠</button><span>{name}</span><button className="account-link" onClick={() => void logout()}>로그아웃</button></>
        : <button className="account-link" onClick={() => { setAuthMode('login'); setScreen('auth'); }}>로그인</button>}</div>
    </header>

    {screen === 'home' && <main className="home main-width">
      <div className="hero-kicker"><span className="sparkle">✳</span> LEARN AT YOUR OWN PACE</div>
      <h1>무엇을 학습하고 싶으세요?</h1>
      <p className="hero-copy">궁금한 주제를 입력하면, 나에게 맞는 학습 방향과<br className="desktop-break" /> 플래시카드를 만들어 드려요.</p>
      <div className={'search-wrap ' + (showResults && results.length > 0 ? 'has-results' : '')}>
        <div className="search-box"><span className="search-icon">⌕</span><Input value={query} onChange={event => { setQuery(event.target.value); setShowResults(true); setError(''); }}
          onFocus={() => setShowResults(true)} onKeyDown={event => { if (event.key === 'Enter') void recommend('', query.trim()); if (event.key === 'Escape') setShowResults(false); }}
          placeholder="예: 와인, 피아노, 세계사" aria-label="학습 주제 입력" maxLength={200} />
          {query && <button className="clear-button" onClick={() => setQuery('')} aria-label="입력 지우기">×</button>}
        </div>
        {showResults && query.trim().length > 0 && results.length > 0 && <Card className="suggestion-dropdown" role="listbox" aria-label="기존 학습 콘텐츠">
          <div className="dropdown-label">이미 만들어진 학습 카드</div>{results.map(item => <button key={item.id} className="result-item" onClick={() => void openSet(item.id)}>
            <span className="result-icon">▤</span><span className="result-text"><strong>{item.title}</strong><small>기존 콘텐츠</small></span><span className="result-arrow">↗</span>
          </button>)}
        </Card>}
      </div>
      <Button disabled={busy || !query.trim()} onClick={() => void recommend('', query.trim())} className="recommend-button">
        {busy ? <><span className="spinner" /> 준비하고 있어요</> : <>AI에게 학습 주제 추천받기 <span>→</span></>}
      </Button>
      <div className="quick-create"><span>다른 자료로 만들기</span>
        <Button variant="outline" onClick={openNewImport}>사진 · TXT · Excel · 붙여넣기</Button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="topic-samples"><span>이런 주제는 어때요?</span>{['와인', '피아노', '세계사', '영어 단어'].map(topic => <button key={topic} onClick={() => setQuery(topic)}>{topic}</button>)}</div>
      <div className="home-foot"><span>✦</span> 관심에서 시작하는 나만의 학습</div>
    </main>}

    {screen === 'suggestions' && <main className="flow main-width">
      <button className="back-link" onClick={goHome}>← 처음으로</button><div className="step-label"><span>STEP 1</span> 학습 방향 선택</div>
      <h1>{message || originalRequest + '에 대해 어떤 내용을 학습하고 싶으세요?'}</h1><p className="flow-copy">마음에 드는 주제를 선택하면 핵심 플래시카드 10장을 만들어요.</p>
      <div className="topic-grid">{suggestions.map((suggestion, index) => <button className="topic-card" key={suggestion.id} onClick={() => void createSet(suggestion)}>
        <span className={'topic-number tone-' + index}>0{index + 1}</span><span className="topic-arrow">↗</span><strong>{suggestion.title}</strong>
        <span className="topic-description">{suggestion.description}</span><span className="goal"><span>학습 목표</span>{suggestion.learning_goal}</span>
      </button>)}</div>
      <div className="refine-panel"><div className="refine-icon">✳</div><div className="refine-body"><strong>원하는 방향이 없나요?</strong><span>더 구체적으로 알려주시면 다시 추천해 드려요.</span>
        <div className="refine-row"><Input value={refinement} onChange={event => setRefinement(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && refinement.trim()) void recommend(refinement.trim()); }}
          placeholder="예: 와인과 어울리는 음식에 대해 공부하고 싶어" maxLength={200} />
          <Button variant="outline" disabled={busy || !refinement.trim()} onClick={() => void recommend(refinement.trim())}>{busy ? '추천 중…' : '다시 추천'}</Button></div>
      </div></div>{error && <p className="error-message" role="alert">{error}</p>}
    </main>}

    {screen === 'generating' && <main className="generating main-width"><div className="loader-orbit"><span>✳</span></div><div className="step-label"><span>STEP 2</span> 카드 준비</div>
      <h1>학습 카드를 만들고 있어요</h1><p>{originalRequest}에서 시작해<br />꼭 필요한 내용 10개를 정리하고 있어요.</p>
      <div className="progress-track"><span /></div><small>잠시만 기다려 주세요</small></main>}

    {screen === 'library' && <main className="library main-width">
      <div className="library-heading"><div><div className="step-label"><span>LEARNING LIBRARY</span> 공개 자료와 내 콘텐츠</div><h1>학습 콘텐츠 목록</h1>
        <p>다시 학습하거나 카드 내용을 수정할 수 있어요.</p></div><Button onClick={openNewImport}>+ 새 콘텐츠 만들기</Button></div>
      <div className="library-toolbar"><Input value={listQuery} onChange={event => { setListQuery(event.target.value); setListPage(1); }} placeholder="제목이나 카드 내용 검색" aria-label="학습 콘텐츠 검색" />
        <select value={listSort} onChange={event => { setListSort(event.target.value as 'newest' | 'name'); setListPage(1); }} aria-label="정렬">
          <option value="newest">최신순</option><option value="name">이름순</option></select>
        <div className="scope-toggle"><button className={listScope === 'all' ? 'selected' : ''} onClick={() => { setListScope('all'); setListPage(1); }}>전체</button>
          <button className={listScope === 'mine' ? 'selected' : ''} onClick={() => { if (!session) { setScreen('auth'); return; } setListScope('mine'); setListPage(1); }}>내 콘텐츠</button></div></div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {busy && <p className="library-state">목록을 불러오는 중…</p>}
      {!busy && listData?.results.length === 0 && <Card className="empty-library"><strong>아직 콘텐츠가 없습니다.</strong><span>자료를 가져오거나 AI로 새 카드를 만들어 보세요.</span><Button onClick={openNewImport}>콘텐츠 만들기</Button></Card>}
      {!busy && listData && listData.results.length > 0 && <div className="content-list">
        {listData.results.map(item => <article className="content-row" key={item.id}>
          <button className="content-main" onClick={() => void openSet(item.id)}>
            <span className="source-chip">{item.source_mode === 'PHOTO' ? '사진' : item.source_mode === 'TEXT' ? 'TXT' : item.source_mode === 'EXCEL' ? 'Excel' : 'AI'}</span>
            <strong>{item.title}</strong><span className="content-meta">
              {item.card_count}개 카드 · 생성 {new Date(item.created_at).toLocaleDateString('ko-KR')} · 수정 {new Date(item.updated_at ?? item.created_at).toLocaleDateString('ko-KR')}
              {item.ai_usage && typeof item.ai_usage.total_tokens === 'number' && Number.isFinite(item.ai_usage.total_tokens) && <span className="ai-cost" title={`입력 ${(item.ai_usage.input_tokens ?? 0).toLocaleString()} · 출력 ${(item.ai_usage.output_tokens ?? 0).toLocaleString()} · 총 ${item.ai_usage.total_tokens.toLocaleString()} tokens\n모델 단가: ${(item.ai_usage.model_rates ?? []).map(rate => `${rate.model}: 입력 $${rate.input_usd_per_million ?? '미등록'} · 캐시 $${rate.cached_input_usd_per_million ?? '미등록'} · 출력 $${rate.output_usd_per_million ?? '미등록'} / 1M tokens (${rate.pricing_as_of})`).join('; ')}\n환율: ${(item.ai_usage.fx_rates ?? []).map(rate => `1 USD = ${rate.usd_krw_rate} KRW (${rate.as_of}, ${rate.source})`).join('; ')}\n실제 청구액이 아닌 추정 API 비용`}>
                {' · 크레딧 '}{item.ai_usage.total_tokens.toLocaleString()}{' tokens'}
                {typeof item.ai_usage.estimated_krw === 'number' && Number.isFinite(item.ai_usage.estimated_krw) && <> · 약 {Math.round(item.ai_usage.estimated_krw).toLocaleString()}원</>}
              </span>}
            </span>
            <span className="content-preview">{item.preview.map(card => card.key + ' — ' + card.values[0]).join(' / ')}</span>
          </button>
          <div className="content-actions"><Button variant="outline" onClick={() => void openSet(item.id)}>학습하기</Button>
            {item.can_edit && <><Button variant="outline" onClick={() => { api.get(item.id).then(set => { setEditing(set); setDraft({ title: set.title, cards: set.cards ?? [], sourceMode: set.source_mode ?? 'AI', issues: [] }); setScreen('editor'); }).catch(reason => setError(reason instanceof Error ? reason.message : '콘텐츠를 불러오지 못했습니다.')); }}>수정하기</Button>
              <Button variant="ghost" onClick={() => void deleteSet(item.id)}>삭제</Button></>}
            <div className="download-actions"><button onClick={() => void downloadSet(item.id, 'xlsx')}>Excel</button><button onClick={() => void downloadSet(item.id, 'txt')}>TXT</button></div>
          </div>
        </article>)}
      </div>}
      {listData && listData.total_pages > 1 && <div className="pagination"><Button variant="outline" disabled={listPage <= 1} onClick={() => setListPage(page => page - 1)}>이전</Button>
        <span>{listData.page} / {listData.total_pages}</span><Button variant="outline" disabled={listPage >= listData.total_pages} onClick={() => setListPage(page => page + 1)}>다음</Button></div>}
    </main>}

    {screen === 'import' && <ImportPanel onReady={onImportReady} onCancel={goHome} />}

    {screen === 'editor' && draft && <ContentEditor title={draft.title} cards={draft.cards} sourceMode={draft.sourceMode}
      initialUpdatedAt={editing?.updated_at} reviewIndexes={draft.reviewIndexes} onSave={saveEditor}
      onCancel={() => { setDraft(null); setEditing(null); setScreen(editing ? 'library' : 'home'); }}
      onReupload={editing?.id ? reuploadExisting : undefined} />}

    {screen === 'auth' && <AuthPanel initialMode={authMode} onDone={() => { setScreen(draft ? 'editor' : 'home'); }}
      onCancel={() => { setPendingSave(null); setScreen(draft ? 'editor' : 'home'); }} />}

    {screen === 'study' && activeSet && <main className="study main-width">
      <button className="back-link" onClick={goHome}>← 다른 주제 학습하기</button>
      <div className="study-heading"><div><div className="step-label"><span>LEARNING SET</span></div><h1>{activeSet.title}</h1></div><span className="card-count">{activeSet.cards?.length ?? 10} CARDS</span></div>
      {activeSet.cards && activeSet.cards.length > 0 ? <>
        <div className="study-progress"><span style={{ width: Math.min(100, ((cardIndex + 1) / activeSet.cards.length) * 100) + '%' }} /></div>
        {cardIndex < activeSet.cards.length && <>
          <button className={'flashcard ' + (flipped ? 'is-flipped' : '')} onClick={() => setFlipped(value => !value)} aria-label={flipped ? '카드 앞면 보기' : '카드 뒷면 보기'}>
            <span className="card-topline"><span>MODU2 · STUDY CARD</span><span>{String(cardIndex + 1).padStart(2, '0')}</span></span>
            <span className="card-center"><span className="card-symbol">{flipped ? '✧' : '✳'}</span><strong>{activeSet.cards[cardIndex].key}</strong>
              {flipped ? <span className="card-values">{activeSet.cards[cardIndex].values.map((value, index) => <span key={index}><i>•</i>{value}</span>)}</span>
                : <span className="flip-hint">눌러서 뒤집기 <b>↻</b></span>}</span>
            <span className="card-bottomline"><span>{flipped ? 'TAP TO SEE FRONT' : 'TAP TO REVEAL'}</span><span>✦</span></span>
          </button>
          <div className="study-controls"><Button variant="outline" disabled={cardIndex === 0} onClick={() => moveCard(-1)}>← 이전 카드</Button>
            <span>{cardIndex + 1} <i>/</i> {activeSet.cards.length}</span>
            <Button onClick={() => cardIndex === activeSet.cards!.length - 1 ? setCardIndex(activeSet.cards!.length) : moveCard(1)}>{cardIndex >= activeSet.cards.length - 1 ? '학습 완료' : '다음 카드 →'}</Button></div>
        </>}
        {cardIndex >= activeSet.cards.length && <Card className="complete-panel"><span className="complete-mark">✓</span><strong>학습을 마쳤어요!</strong>
          <span>한 번 더 복습하거나 다른 주제를 학습해 보세요.</span><div><Button variant="outline" onClick={() => { setCardIndex(0); setFlipped(false); }}>다시 학습하기</Button><Button onClick={goHome}>새 주제 학습하기</Button></div></Card>}
      </> : <p className="error-message">카드 내용을 찾을 수 없습니다.</p>}
      <div className="study-actions">
        {activeSet.can_edit && <Button variant="outline" onClick={async () => { const set = await api.get(activeSet.id); setEditing(set); setDraft({ title: set.title, cards: set.cards ?? [], sourceMode: set.source_mode ?? 'AI', issues: [] }); setScreen('editor'); }}>내용 수정하기</Button>}
        {activeSet.saved === false && <Button variant="outline" onClick={() => { setEditing(null); setDraft({ title: activeSet.title, cards: activeSet.cards ?? [], sourceMode: activeSet.source_mode ?? 'AI', issues: [], aiUsageSessionId: activeSet.ai_usage_session_id, aiUsageSessionToken: activeSet.ai_usage_session_token }); setScreen('editor'); }}>내 콘텐츠로 저장</Button>}
      </div>
    </main>}

    <footer className="footer">© MODU2 <span>·</span> Learn something new, every day.</footer>
  </div>;
}
