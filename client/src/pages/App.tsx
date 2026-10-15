import { useEffect, useRef, useState } from 'react';
import { api, type ContentSet } from '../lib/api';
import type { Suggestion } from '../../../shared/schemas/index';
import { Button, Card, Input } from '../components/ui';

type Screen = 'home' | 'suggestions' | 'generating' | 'study';
export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentSet[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [message, setMessage] = useState('');
  const [refinement, setRefinement] = useState('');
  const [originalRequest, setOriginalRequest] = useState('');
  const [activeSet, setActiveSet] = useState<ContentSet | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const searchSequence = useRef(0);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const seq = ++searchSequence.current;
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.search(query.trim());
        if (seq === searchSequence.current) setResults(data.results);
      } catch { if (seq === searchSequence.current) setResults([]); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function recommend(refine = '', subjectOverride?: string) {
    const subject = subjectOverride ?? (originalRequest || query.trim());
    if (!subject) { setError('먼저 학습하고 싶은 주제를 입력해 주세요.'); return; }
    const previous = subjectOverride ? [] : suggestions;
    setError(''); setBusy(true); setOriginalRequest(subject); setSuggestions(previous); setShowResults(false);
    try {
      const data = await api.suggestions({ original_request: subject, refinement_request: refine, previous_suggestions: previous });
      setSuggestions(data.suggestions); setMessage(data.message); setRefinement(''); setScreen('suggestions');
    } catch (e) { setError(e instanceof Error ? e.message : '추천을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function openSet(id: string) {
    setBusy(true); setError(''); setShowResults(false);
    try { const set = await api.get(id); setActiveSet(set); setCardIndex(0); setFlipped(false); setScreen('study'); }
    catch (e) { setError(e instanceof Error ? e.message : '콘텐츠를 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function createSet(suggestion: Suggestion) {
    setError(''); setScreen('generating');
    try {
      const set = await api.create({ original_request: originalRequest, selected_topic: suggestion.title,
        learning_goal: suggestion.learning_goal, client_request_id: crypto.randomUUID() });
      const complete = set.cards ? set : await api.get(set.id);
      setActiveSet(complete); setCardIndex(0); setFlipped(false); setScreen('study');
    } catch (e) { setError(e instanceof Error ? e.message : '카드 생성에 실패했습니다.'); setScreen('suggestions'); }
  }
  function moveCard(delta: number) {
    const last = (activeSet?.cards?.length ?? 0) - 1;
    setCardIndex(i => Math.max(0, Math.min(last, i + delta))); setFlipped(false);
  }
  function goHome() { setScreen('home'); setActiveSet(null); setError(''); setShowResults(false); }

  return <div className="app-shell">
    <header className="topbar"><button className="brand" onClick={goHome} aria-label="MODU2 홈으로">
      <span className="brand-mark"><span /><span /></span><span>MODU<span className="brand-two">2</span></span>
    </button><span className="header-note">작은 카드로, 깊게 배우기</span></header>

    {screen === 'home' && <main className="home main-width">
      <div className="hero-kicker"><span className="sparkle">✳</span> LEARN AT YOUR OWN PACE</div>
      <h1>무엇을 학습하고 싶으세요?</h1>
      <p className="hero-copy">궁금한 주제를 입력하면, 나에게 맞는 학습 방향과<br className="desktop-break" /> 플래시카드를 만들어 드려요.</p>
      <div className={`search-wrap ${showResults && results.length > 0 ? 'has-results' : ''}`}>
        <div className="search-box"><span className="search-icon">⌕</span><Input value={query} onChange={e => { setQuery(e.target.value); setShowResults(true); setError(''); }}
          onFocus={() => setShowResults(true)} onKeyDown={e => { if (e.key === 'Enter') recommend('', query.trim()); if (e.key === 'Escape') setShowResults(false); }}
          placeholder="예: 와인, 피아노, 세계사" aria-label="학습 주제 입력" maxLength={200} />
          {query && <button className="clear-button" onClick={() => setQuery('')} aria-label="입력 지우기">×</button>}
        </div>
        {showResults && query.trim().length > 0 && results.length > 0 && <Card className="suggestion-dropdown" role="listbox" aria-label="기존 학습 콘텐츠">
          <div className="dropdown-label">이미 만들어진 학습 카드</div>
          {results.map(item => <button key={item.id} className="result-item" onClick={() => openSet(item.id)}>
            <span className="result-icon">▤</span><span className="result-text"><strong>{item.title}</strong><small>기존 콘텐츠 · 10개 카드</small></span><span className="result-arrow">↗</span>
          </button>)}
        </Card>}
      </div>
      <Button disabled={busy || !query.trim()} onClick={() => recommend('', query.trim())} className="recommend-button">
        {busy ? <><span className="spinner" /> 준비하고 있어요</> : <>AI에게 학습 주제 추천받기 <span>→</span></>}
      </Button>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="topic-samples"><span>이런 주제는 어때요?</span>{['와인', '피아노', '세계사', '영어 단어'].map(t => <button key={t} onClick={() => setQuery(t)}>{t}</button>)}</div>
      <div className="home-foot"><span>✦</span> 관심에서 시작하는 나만의 학습</div>
    </main>}

    {screen === 'suggestions' && <main className="flow main-width">
      <button className="back-link" onClick={goHome}>← 처음으로</button>
      <div className="step-label"><span>STEP 1</span> 학습 방향 선택</div>
      <h1>{message || `${originalRequest}에 대해 어떤 내용을 학습하고 싶으세요?`}</h1>
      <p className="flow-copy">마음에 드는 주제를 선택하면 핵심 플래시카드 10장을 만들어요.</p>
      <div className="topic-grid">{suggestions.map((s, i) => <button className="topic-card" key={s.id} onClick={() => createSet(s)}>
        <span className={`topic-number tone-${i}`}>0{i + 1}</span><span className="topic-arrow">↗</span>
        <strong>{s.title}</strong><span className="topic-description">{s.description}</span>
        <span className="goal"><span>학습 목표</span>{s.learning_goal}</span>
      </button>)}</div>
      <div className="refine-panel"><div className="refine-icon">✳</div><div className="refine-body"><strong>원하는 방향이 없나요?</strong><span>더 구체적으로 알려주시면 다시 추천해 드려요.</span>
        <div className="refine-row"><Input value={refinement} onChange={e => setRefinement(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && refinement.trim()) recommend(refinement.trim()); }} placeholder="예: 와인과 어울리는 음식에 대해 공부하고 싶어" maxLength={200} />
          <Button variant="outline" disabled={busy || !refinement.trim()} onClick={() => recommend(refinement.trim())}>{busy ? '추천 중…' : '다시 추천'}</Button></div>
      </div></div>{error && <p className="error-message" role="alert">{error}</p>}
    </main>}

    {screen === 'generating' && <main className="generating main-width"><div className="loader-orbit"><span>✳</span></div><div className="step-label"><span>STEP 2</span> 카드 준비</div>
      <h1>학습 카드를 만들고 있어요</h1><p>{originalRequest}에서 시작해<br />꼭 필요한 내용 10개를 정리하고 있어요.</p>
      <div className="progress-track"><span /></div><small>잠시만 기다려 주세요</small></main>}

    {screen === 'study' && activeSet && <main className="study main-width">
      <button className="back-link" onClick={goHome}>← 다른 주제 학습하기</button>
      <div className="study-heading"><div><div className="step-label"><span>LEARNING SET</span></div><h1>{activeSet.title}</h1></div><span className="card-count">{activeSet.cards?.length ?? 10} CARDS</span></div>
      {activeSet.cards && activeSet.cards.length > 0 ? <>
        <div className="study-progress"><span style={{ width: `${((cardIndex + 1) / activeSet.cards.length) * 100}%` }} /></div>
        {cardIndex < activeSet.cards.length && <>
        <button className={`flashcard ${flipped ? 'is-flipped' : ''}`} onClick={() => setFlipped(v => !v)} aria-label={flipped ? '카드 앞면 보기' : '카드 뒷면 보기'}>
          <span className="card-topline"><span>MODU2 · STUDY CARD</span><span>{String(cardIndex + 1).padStart(2, '0')}</span></span>
          <span className="card-center"><span className="card-symbol">{flipped ? '✧' : '✳'}</span><strong>{activeSet.cards[cardIndex].key}</strong>
            {flipped ? <span className="card-values">{activeSet.cards[cardIndex].values.map((v, i) => <span key={i}><i>•</i>{v}</span>)}</span> : <span className="flip-hint">눌러서 뒤집기 <b>↻</b></span>}
          </span><span className="card-bottomline"><span>{flipped ? 'TAP TO SEE FRONT' : 'TAP TO REVEAL'}</span><span>✦</span></span>
        </button>
        <div className="study-controls"><Button variant="outline" disabled={cardIndex === 0} onClick={() => moveCard(-1)}>← 이전 카드</Button><span>{cardIndex + 1} <i>/</i> {activeSet.cards.length}</span>
          <Button onClick={() => cardIndex === activeSet.cards!.length - 1 ? setCardIndex(activeSet.cards!.length) : moveCard(1)}>{cardIndex >= activeSet.cards.length - 1 ? '학습 완료' : '다음 카드 →'}</Button></div>
        </>}
        {cardIndex >= activeSet.cards.length && <Card className="complete-panel"><span className="complete-mark">✓</span><strong>학습을 마쳤어요!</strong><span>한 번 더 복습하거나 다른 주제를 학습해 보세요.</span>
          <div><Button variant="outline" onClick={() => { setCardIndex(0); setFlipped(false); }}>다시 학습하기</Button><Button onClick={goHome}>새 주제 학습하기</Button></div></Card>}
      </> : <p className="error-message">카드 내용을 찾을 수 없습니다.</p>}
    </main>}
    <footer className="footer">© MODU2 <span>·</span> Learn something new, every day.</footer>
  </div>;
}
