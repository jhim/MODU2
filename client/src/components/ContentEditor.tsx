import { useState } from 'react';
import type { Flashcard } from '../../../shared/schemas/index';
import type { SourceMode } from '../lib/api';
import { Button, Card, Input } from './ui';

type Props = {
  title: string;
  cards: Flashcard[];
  sourceMode: SourceMode;
  initialUpdatedAt?: string;
  reviewIndexes?: number[];
  onSave: (input: { title: string; cards: Flashcard[]; sourceMode: SourceMode; expectedUpdatedAt?: string }) => Promise<void>;
  onCancel: () => void;
  onReupload?: (file: File, currentTitle: string) => Promise<{ title: string; cards: Flashcard[]; currentCards: Flashcard[]; sourceMode: SourceMode; issues: { row: number; message: string }[] }>;
};
export function ContentEditor({ title: initialTitle, cards: initialCards, sourceMode: initialSource,
  initialUpdatedAt, reviewIndexes = [], onSave, onCancel, onReupload }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [cards, setCards] = useState(initialCards.map(card => ({ key: card.key, values: [...card.values] })));
  const [source, setSource] = useState<SourceMode>(initialSource);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<{ row: number; message: string }[]>([]);
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());
  const [reviewOrder, setReviewOrder] = useState(reviewIndexes);
  const [pending, setPending] = useState<{ title: string; cards: Flashcard[]; currentCards: Flashcard[]; sourceMode: SourceMode } | null>(null);
  function changeCard(index: number, next: Flashcard) { setCards(old => old.map((card, i) => i === index ? next : card)); }
  function move(index: number, delta: number) {
    const target = index + delta; if (target < 0 || target >= cards.length) return;
    setCards(old => { const copy = [...old]; [copy[index], copy[target]] = [copy[target]!, copy[index]!]; return copy; });
    setReviewOrder(old => old.map(value => value === index ? target : value === target ? index : value));
    setReviewed(old => new Set([...old].map(value => value === index ? target : value === target ? index : value)));
  }
  function replacementSummary() {
    if (!pending) return null;
    const before = new Map(pending.currentCards.map(card => [card.key.toLocaleLowerCase(), card]));
    const after = new Map(pending.cards.map(card => [card.key.toLocaleLowerCase(), card]));
    const added = pending.cards.filter(card => !before.has(card.key.toLocaleLowerCase()));
    const removed = pending.currentCards.filter(card => !after.has(card.key.toLocaleLowerCase()));
    const changed = pending.cards.filter(card => {
      const old = before.get(card.key.toLocaleLowerCase());
      return old && JSON.stringify(old.values) !== JSON.stringify(card.values);
    });
    return { added, removed, changed };
  }  async function save() {
    setError(''); setBusy(true);
    try {
      if (!title.trim() || title.trim().length > 120) throw new Error('제목은 1~120자로 입력해 주세요.');
      if (!cards.length || cards.length > 500) throw new Error('카드는 1~500개여야 합니다.');
      if (issues.length) throw new Error('오류 행을 제외하거나 파일 내용을 수정해 주세요.');
      if (reviewOrder.some(index => !reviewed.has(index))) throw new Error('검토 필요 표시가 있는 카드를 확인한 뒤 저장해 주세요.');
      const keys = cards.map(card => card.key.trim().toLocaleLowerCase());
      if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error('카드 앞면은 비워둘 수 없고 서로 달라야 합니다.');
      if (cards.some(card => !card.values.length || card.values.length > 6 || card.values.some(value => !value.trim()))) throw new Error('각 카드의 뒷면 값은 1~6개여야 합니다.');
      await onSave({ title: title.trim(), cards, sourceMode: source, expectedUpdatedAt: initialUpdatedAt });
    } catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function chooseReplacement(file: File) {
    if (!onReupload) return;
    setBusy(true); setError('');
    try {
      const result = await onReupload(file, title);
      setIssues(result.issues);
      setPending({ title: result.title || title, cards: result.cards, currentCards: result.currentCards, sourceMode: result.sourceMode });
    } catch (reason) { setError(reason instanceof Error ? reason.message : '파일을 읽지 못했습니다.'); }
    finally { setBusy(false); }
  }
  return <main className="editor-page main-width">
    <button className="back-link" onClick={onCancel}>← 콘텐츠 목록으로</button>
    <div className="editor-heading"><div><div className="step-label"><span>CONTENT EDITOR</span> 변경 내용은 저장 전까지 반영되지 않습니다</div>
      <h1>{initialUpdatedAt ? '학습 콘텐츠 수정' : '새 학습 콘텐츠'}</h1></div>
      <span className="editor-count">{cards.length}개 카드</span></div>
    <label className="title-field">콘텐츠 제목<Input maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
    {initialUpdatedAt && onReupload && <div className="replace-file"><span>Excel/TXT 수정본으로 교체</span>
      <label className="file-button">파일 선택<input type="file" accept=".xlsx,.txt,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void chooseReplacement(file); event.currentTarget.value = ''; }} /></label>
    </div>}
    {issues.length > 0 && <div className="inline-alert">가져온 파일의 오류 행 {issues.map(issue => issue.row).join(', ')}: {issues.map(issue => issue.message).join(' · ')}<button onClick={() => setIssues([])}>오류 행을 제외하고 계속</button></div>}
    <div className="card-editor-list">
      {cards.map((card, index) => <Card key={index} className="card-editor">
        <div className="card-editor-top"><strong>카드 {index + 1}</strong>
          {reviewOrder.includes(index) && <><span className="review-tag">내용 검토 필요</span><label className="review-ack"><input type="checkbox" checked={reviewed.has(index)} onChange={event => setReviewed(old => { const next = new Set(old); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />확인</label></>}
          <div><button onClick={() => move(index, -1)} disabled={index === 0} aria-label="위로 이동">↑</button>
            <button onClick={() => move(index, 1)} disabled={index === cards.length - 1} aria-label="아래로 이동">↓</button>
            <button className="delete-row" onClick={() => setCards(old => old.filter((_, i) => i !== index))}>삭제</button></div>
        </div>
        <label>앞면<Input maxLength={120} value={card.key} onChange={event => changeCard(index, { ...card, key: event.target.value })} placeholder="질문 또는 용어" /></label>
        <div className="value-editor"><span>뒷면 값 (최대 6개)</span>
          {card.values.map((value, valueIndex) => <div className="value-row" key={valueIndex}>
            <Input maxLength={500} value={value} onChange={event => changeCard(index, { ...card,
              values: card.values.map((item, i) => i === valueIndex ? event.target.value : item) })} placeholder={'답변 ' + (valueIndex + 1)} />
            {card.values.length > 1 && <button onClick={() => changeCard(index, { ...card, values: card.values.filter((_, i) => i !== valueIndex) })} aria-label="답변 삭제">×</button>}
          </div>)}
          {card.values.length < 6 && <button className="text-action" onClick={() => changeCard(index, { ...card, values: [...card.values, ''] })}>+ 답변 추가</button>}
        </div>
      </Card>)}
    </div>
    {cards.length < 500 && <Button variant="outline" onClick={() => setCards(old => [...old, { key: '', values: [''] }])}>+ 카드 추가</Button>}
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="editor-actions"><Button variant="outline" onClick={onCancel}>취소</Button>
      <Button onClick={() => void save()} disabled={busy}>{busy ? '저장 중…' : '변경 사항 저장'}</Button></div>
    {pending && <div className="modal-scrim" role="presentation"><section className="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="replace-heading">
      <h2 id="replace-heading">파일 내용 확인</h2><p>현재 {cards.length}개 카드에서 {pending.cards.length}개 카드로 바뀝니다. 미리보기 내용을 편집기에서 확인한 뒤 저장해야 반영됩니다.</p>
      <div className="replace-preview">
        {(() => { const summary = replacementSummary()!; return <>
          <strong>카드 변경</strong><span>추가 {summary.added.length} · 내용 변경 {summary.changed.length} · 삭제 {summary.removed.length}</span>
          {[...summary.added.map(card => '추가: ' + card.key), ...summary.changed.map(card => '수정: ' + card.key), ...summary.removed.map(card => '삭제: ' + card.key)].slice(0, 8).map((line, index) => <span key={index}>{line}</span>)}
          {!summary.added.length && !summary.changed.length && !summary.removed.length && <span>카드 내용 변경 없음</span>}
        </>; })()}
      </div>
      <div><Button variant="outline" onClick={() => setPending(null)}>취소</Button><Button onClick={() => {
        setTitle(pending.title); setCards(pending.cards); setSource(pending.sourceMode); setIssues([]); setReviewOrder([]); setReviewed(new Set()); setPending(null);
      }}>편집기에 적용</Button></div>
    </section></div>}
  </main>;
}
