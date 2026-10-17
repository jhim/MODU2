import { useEffect, useMemo, useState } from 'react';
import { api, type AdminPromptKey, type AdminPromptTemplate, type AdminPromptVersion, type RequestPromptMessage } from '../lib/api';
import { Button } from './ui';

const PROMPTS: { key: AdminPromptKey; title: string; detail: string }[] = [
  { key: 'RECOMMEND', title: '학습 주제 추천', detail: '추천 범위와 관점 구성' },
  { key: 'FLASHCARD', title: '플래시카드 생성', detail: 'Key/Value 카드 10개 생성' },
];
const blankInput = { original_request: '각 나라별 와인의 특징', refinement_request: '', previous_titles: [] as string[],
  selected_topic: '세계 주요 국가별 와인의 특징', learning_goal: '여러 나라 와인의 공통점과 차이를 설명한다' };
const statusLabel: Record<AdminPromptVersion['status'], string> = { ACTIVE: '운영 중', DRAFT: '초안', ARCHIVED: '보관됨' };

export function PromptAdminPage({ onBack }: { onBack: () => void }) {
  const [key, setKey] = useState<AdminPromptKey>('RECOMMEND');
  const [templates, setTemplates] = useState<AdminPromptTemplate[]>([]);
  const [versions, setVersions] = useState<AdminPromptVersion[]>([]);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.adminAudit>>['audit_logs']>([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState({ system_prompt: '', developer_prompt: '', user_template: '', change_note: '' });
  const [previewInput, setPreviewInput] = useState(blankInput);
  const [previewMessages, setPreviewMessages] = useState<RequestPromptMessage[] | null>(null);
  const [compareId, setCompareId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [catalog, history] = await Promise.all([api.adminPrompts(), api.adminAudit(key)]);
    setTemplates(catalog.prompts); setAudit(history.audit_logs);
    const template = catalog.prompts.find(item => item.prompt_key === key);
    const rows = template?.versions ?? [];
    setVersions(rows);
    const selected = rows.find(item => item.id === selectedId) ?? rows.find(item => item.status === 'DRAFT') ?? rows.find(item => item.status === 'ACTIVE') ?? rows[0];
    setSelectedId(selected?.id ?? '');
    if (selected) setForm({ system_prompt: selected.system_prompt, developer_prompt: selected.developer_prompt,
      user_template: selected.user_template, change_note: selected.change_note ?? '' });
  }
  useEffect(() => { setSelectedId(''); setPreviewMessages(null); setError(''); void refresh().catch(reason => setError(reason instanceof Error ? reason.message : '프롬프트를 불러오지 못했습니다.')); }, [key]);
  const active = useMemo(() => versions.find(version => version.status === 'ACTIVE'), [versions]);
  const selected = useMemo(() => versions.find(version => version.id === selectedId), [versions, selectedId]);
  const compare = useMemo(() => versions.find(version => version.id === compareId), [versions, compareId]);
  const editable = selected?.status === 'DRAFT';
  const template = templates.find(item => item.prompt_key === key);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 완료하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  function selectVersion(version: AdminPromptVersion) {
    setSelectedId(version.id); setForm({ system_prompt: version.system_prompt, developer_prompt: version.developer_prompt,
      user_template: version.user_template, change_note: version.change_note ?? '' }); setPreviewMessages(null);
  }
  async function createDraft() {
    setBusy(true); setError('');
    try { const created = await api.adminCreateDraft(key, '운영 버전에서 새 초안 생성'); setNotice(`v${created.version.version_number} 초안을 만들었습니다.`); await refresh(); selectVersion(created.version); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '초안을 만들지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function saveDraft() {
    if (!selected || !editable) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const validation = await api.adminValidateDraft(key, selected.id, form);
      if (!validation.valid) throw new Error(validation.errors.join('\n'));
      await api.adminUpdateDraft(key, selected.id, form); setNotice(`v${selected.version_number} 초안을 저장했습니다.`); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '초안을 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function activate() {
    if (!selected || !active || !editable) return;
    if (!window.confirm(`v${selected.version_number}을 운영 프롬프트로 적용할까요?`)) return;
    await run(() => api.adminActivate(key, selected.id, active.id), `v${selected.version_number}을 운영에 적용했습니다.`);
  }
  async function restore(version: AdminPromptVersion) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.adminRestore(key, version.id, `v${version.version_number}에서 복원`);
      await refresh(); selectVersion(result.version); setNotice(`v${version.version_number}의 내용으로 새 초안을 만들었습니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '이전 버전을 복원하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function preview() {
    if (!selected) return;
    setBusy(true); setError('');
    try { const result = await api.adminPreview(key, selected.id, previewInput); setPreviewMessages(result.messages); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '미리보기를 만들지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function copyMessages(messages: RequestPromptMessage[]) {
    await navigator.clipboard.writeText(messages.map(message => `${message.role.toUpperCase()}\n${message.content}`).join('\n\n'));
    setNotice('프롬프트를 클립보드에 복사했습니다.');
  }
  const copySelected = () => selected && copyMessages([
    { role: 'system', content: form.system_prompt }, { role: 'developer', content: form.developer_prompt },
    { role: 'user', content: form.user_template },
  ]);

  return <main className="prompt-admin main-width">
    <div className="prompt-admin-heading"><div><span className="step-label"><span>관리자 설정</span> AI 프롬프트</span><h1>AI 프롬프트 관리</h1>
      <p>운영 중인 문구를 보존하면서 초안을 검토하고 버전별로 적용합니다.</p></div><Button variant="outline" onClick={onBack}>화면 닫기</Button></div>
    <div className="prompt-admin-tabs" role="tablist" aria-label="프롬프트 유형">
      {PROMPTS.map(item => <button key={item.key} role="tab" aria-selected={key === item.key} className={key === item.key ? 'selected' : ''} onClick={() => setKey(item.key)}>
        <strong>{item.title}</strong><span>{item.detail}</span></button>)}
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="prompt-notice" role="status">{notice}</p>}
    <div className="prompt-admin-grid">
      <aside className="prompt-version-rail"><div className="prompt-rail-heading"><div><strong>버전 이력</strong><span>{template?.name ?? '불러오는 중'}</span></div>
        <Button onClick={() => void createDraft()} disabled={busy || !active}>새 초안</Button></div>
        {versions.map(version => <button key={version.id} className={'prompt-version-item ' + (selectedId === version.id ? 'selected' : '')} onClick={() => selectVersion(version)}>
          <span><strong>v{version.version_number}</strong><small className={`prompt-status status-${version.status.toLowerCase()}`}>{statusLabel[version.status]}</small></span>
          <span className="prompt-version-note">{version.change_note || '메모 없음'}</span><time>{new Date(version.created_at).toLocaleString('ko-KR')}</time>
        </button>)}
        {selected?.status === 'ARCHIVED' && <Button variant="outline" className="restore-button" onClick={() => void restore(selected)} disabled={busy}>이 버전 내용으로 복원</Button>}
      </aside>
      <section className="prompt-editor-pane">
        <div className="prompt-pane-heading"><div><span className="prompt-status status-live">현재 운영 v{active?.version_number ?? '—'}</span>
          <h2>{selected ? `v${selected.version_number} ${statusLabel[selected.status]}` : '버전을 선택하세요'}</h2></div>
          <div className="prompt-toolbar"><Button variant="outline" onClick={() => void copySelected()} disabled={!selected}>전체 복사</Button>
            {editable && <><Button variant="outline" onClick={() => void saveDraft()} disabled={busy}>초안 저장</Button>
              <Button onClick={() => void activate()} disabled={busy || !active}>운영 적용</Button></>}</div></div>
        {selected && <>
          <label className="prompt-field"><span>변경 메모</span><input value={form.change_note} disabled={!editable} maxLength={500} onChange={event => setForm({ ...form, change_note: event.target.value })} /></label>
          <label className="prompt-field"><span>System 메시지</span><textarea value={form.system_prompt} disabled={!editable} onChange={event => setForm({ ...form, system_prompt: event.target.value })} /></label>
          <label className="prompt-field"><span>Developer 메시지</span><textarea value={form.developer_prompt} disabled={!editable} onChange={event => setForm({ ...form, developer_prompt: event.target.value })} /></label>
          <label className="prompt-field"><span>User 메시지 템플릿</span><textarea className="prompt-template-textarea" value={form.user_template} disabled={!editable} onChange={event => setForm({ ...form, user_template: event.target.value })} />
            <small>{key === 'RECOMMEND' ? '{{original_request_json}}, {{refinement_request_json}}, {{previous_titles_json}}' : '{{original_request_json}}, {{selected_topic_json}}, {{learning_goal_json}}'}</small></label>
        </>}
      </section>
    </div>
    {selected && <section className="prompt-lab">
      <div className="prompt-lab-heading"><div><span className="step-label"><span>실제 API 전송 메시지</span></span><h2>프롬프트 미리보기</h2>
        <p>OpenAI API를 호출하지 않고 선택한 버전과 같은 메시지 빌더로 구성합니다.</p></div><Button onClick={() => void preview()} disabled={busy}>미리보기 만들기</Button></div>
      <div className="prompt-preview-inputs"><label>최초 요청<input value={previewInput.original_request} onChange={event => setPreviewInput({ ...previewInput, original_request: event.target.value })} /></label>
        {key === 'RECOMMEND' ? <><label>추가 조건<input value={previewInput.refinement_request} onChange={event => setPreviewInput({ ...previewInput, refinement_request: event.target.value })} /></label>
          <label>이전 제목<input value={previewInput.previous_titles.join(', ')} onChange={event => setPreviewInput({ ...previewInput, previous_titles: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} /></label></>
          : <><label>선택 주제<input value={previewInput.selected_topic} onChange={event => setPreviewInput({ ...previewInput, selected_topic: event.target.value })} /></label>
            <label>학습 목표<input value={previewInput.learning_goal} onChange={event => setPreviewInput({ ...previewInput, learning_goal: event.target.value })} /></label></>}</div>
      {previewMessages && <div className="prompt-preview-result"><div className="prompt-preview-title"><strong>v{selected.version_number} · System / Developer / User</strong>
          <Button variant="outline" onClick={() => void copyMessages(previewMessages)}>미리보기 복사</Button></div>
        {previewMessages.map((message, index) => <article key={`${message.role}-${index}`}><strong>{message.role}</strong><pre>{message.content}</pre></article>)}</div>}
    </section>}
    <section className="prompt-history-grid"><div className="prompt-history-pane"><div className="prompt-lab-heading"><div><span className="step-label"><span>버전 비교</span></span><h2>내용 비교</h2></div>
        <select aria-label="비교할 버전" value={compareId} onChange={event => setCompareId(event.target.value)}><option value="">버전 선택</option>{versions.filter(item => item.id !== selectedId).map(item => <option key={item.id} value={item.id}>v{item.version_number} · {statusLabel[item.status]}</option>)}</select></div>
        {compare && selected && <div className="prompt-compare"><div className="prompt-compare-head"><span>v{compare.version_number}</span><span>v{selected.version_number}</span></div>
          {(['system_prompt', 'developer_prompt', 'user_template'] as const).map(field => <section key={field}><strong>{field === 'system_prompt' ? 'System' : field === 'developer_prompt' ? 'Developer' : 'User template'}</strong>
            <div><pre>{compare[field]}</pre><pre>{selected[field]}</pre></div></section>)}</div>}
      </div><div className="prompt-history-pane"><div className="prompt-lab-heading"><div><span className="step-label"><span>변경 기록</span></span><h2>관리자 변경 이력</h2></div></div>
        {audit.length === 0 ? <p className="prompt-empty">아직 변경 이력이 없습니다.</p> : <div className="prompt-audit-list">{audit.map(item => <article key={item.id}>
          <span>{item.action}</span><strong>{item.change_summary}</strong><time>{new Date(item.created_at).toLocaleString('ko-KR')}</time></article>)}</div>}</div></section>
  </main>;
}
