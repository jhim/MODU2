import { useEffect, useMemo, useState } from 'react';
import type { Flashcard } from '../../../shared/schemas/index';
import { api, type ImportPreview } from '../lib/api';
import { Button, Card, Input } from './ui';

type ImportSource = 'PHOTO' | 'TEXT' | 'EXCEL';
type Ready = { title: string; cards: Flashcard[]; sourceMode: ImportSource; issues: ImportPreview['issues']; reviewIndexes?: number[]; aiUsageSessionId?: string; aiUsageSessionToken?: string };
type SheetMeta = { name: string; columns: { index: number; name: string }[]; preview: string[][] };

export function ImportPanel({ onReady, onCancel }: { onReady: (ready: Ready) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<ImportSource>('TEXT');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [sheets, setSheets] = useState<SheetMeta[]>([]);
  const [sheetName, setSheetName] = useState('');
  const [keyColumn, setKeyColumn] = useState(1);
  const [valueColumns, setValueColumns] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file || mode !== 'PHOTO') { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(file); setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, mode]);
  const selectedSheet = useMemo(() => sheets.find(item => item.name === sheetName), [sheets, sheetName]);

  function selectFile(next: File | null) {
    setError(''); setFile(next); setSheets([]); setSheetName('');
    if (!next) return;
    const lower = next.name.toLocaleLowerCase();
    if (mode === 'PHOTO' && !(/\.(jpe?g|png|webp)$/.test(lower) && ['image/jpeg', 'image/png', 'image/webp'].includes(next.type))) {
      setError('JPG, PNG, WebP 사진만 선택할 수 있습니다.'); setFile(null); return;
    }
    if (mode === 'TEXT' && !lower.endsWith('.txt')) { setError('UTF-8 .txt 파일만 선택할 수 있습니다.'); setFile(null); return; }
    if (mode === 'EXCEL' && !lower.endsWith('.xlsx')) { setError('.xlsx 파일만 선택할 수 있습니다.'); setFile(null); return; }
    setTitle(next.name.replace(/\.(txt|xlsx|jpe?g|png|webp)$/i, ''));
  }
  async function inspectExcel(next: File) {
    setBusy(true); setError('');
    try {
      if (next.size > 5 * 1024 * 1024) throw new Error('Excel 파일은 5MB 이하만 업로드할 수 있습니다.');
      const result = await api.inspectExcel(next);
      setSheets(result.sheets);
      const first = result.sheets[0];
      if (!first) throw new Error('워크북에 시트가 없습니다.');
      setSheetName(first.name);
      const detectedKey = first.columns.find(column => ['key_text', 'key', 'front', 'question', 'term', 'word', '앞면', '질문', '단어'].includes(column.name.toLocaleLowerCase()))?.index ?? 1;
      setKeyColumn(detectedKey);
      setValueColumns(first.columns.map(column => column.index).filter(index => index !== detectedKey).slice(0, 6));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Excel 파일을 읽지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function prepare() {
    setBusy(true); setError('');
    try {
      if (!title.trim()) throw new Error('콘텐츠 제목을 입력해 주세요.');
      let result: ImportPreview, reviewIndexes: number[] = [], aiUsageSessionId: string | undefined, aiUsageSessionToken: string | undefined;
      if (mode === 'PHOTO') {
        if (!file) throw new Error('사진을 선택해 주세요.');
        if (file.size > 8 * 1024 * 1024) throw new Error('사진은 8MB 이하만 업로드할 수 있습니다.');
        const extracted = await api.extractPhoto(file); result = { cards: extracted.cards, issues: [] };
        reviewIndexes = extracted.review_card_indexes; aiUsageSessionId = extracted.ai_usage_session_id; aiUsageSessionToken = extracted.ai_usage_session_token;
      } else if (mode === 'TEXT') {
        const source = file ? new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) : text;
        if (!source.trim()) throw new Error('TXT 파일을 선택하거나 텍스트를 붙여넣어 주세요.');
        result = await api.parseText(source);
      } else {
        if (!file) throw new Error('Excel 파일을 선택해 주세요.');
        if (!sheetName) throw new Error('가져올 시트를 선택해 주세요.');
        result = await api.parseExcel(file, sheetName, keyColumn, valueColumns);
      }
      if (!result.cards.length && !result.issues.length) throw new Error('가져올 카드가 없습니다.');
      onReady({ title: title.trim(), cards: result.cards, sourceMode: mode, issues: result.issues, reviewIndexes, aiUsageSessionId, aiUsageSessionToken });
    } catch (reason) { setError(reason instanceof Error ? reason.message : '가져오기를 준비하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  return <main className="import-page main-width">
    <button className="back-link" onClick={onCancel}>← 처음으로</button>
    <div className="step-label"><span>CREATE CONTENT</span> 시작 자료를 골라 주세요</div>
    <h1>무엇으로 카드를 만들까요?</h1>
    <p className="flow-copy">추출한 내용은 저장 전에 직접 확인하고 수정할 수 있어요.</p>
    <div className="import-tabs" role="tablist" aria-label="생성 방식">
      {([['PHOTO', '사진'], ['TEXT', 'TXT · 붙여넣기'], ['EXCEL', 'Excel']] as const).map(([value, label]) =>
        <button role="tab" aria-selected={mode === value} className={mode === value ? 'selected' : ''} key={value}
          onClick={() => { setMode(value); setFile(null); setError(''); setSheets([]); }}>{label}</button>)}
    </div>
    <Card className="import-source">
      {mode === 'PHOTO' && <div className="source-body">
        <p>사진 속 글자를 카드로 옮깁니다. 흐리거나 판독하기 어려운 카드는 검토 표시가 붙습니다.</p>
        <label className="file-button">사진 선택<input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          onChange={event => selectFile(event.currentTarget.files?.[0] ?? null)} /></label>
        {previewUrl && <img className="photo-preview" src={previewUrl} alt="선택한 사진 미리보기" />}
      </div>}
      {mode === 'TEXT' && <div className="source-body">
        <label className="file-button">TXT 파일 선택<input type="file" accept=".txt,text/plain" onChange={event => selectFile(event.currentTarget.files?.[0] ?? null)} /></label>
        {file && <span className="selected-file">{file.name}</span>}
        <label className="paste-field">또는 텍스트 붙여넣기
          <textarea value={text} onChange={event => setText(event.target.value)} placeholder={'앞면\t답변 1\t답변 2\napple\t사과\t과일'} rows={8} />
        </label>
        <p className="hint">탭으로 구분된 Excel 표도 붙여넣을 수 있습니다. UTF-8, 최대 2MB.</p>
      </div>}
      {mode === 'EXCEL' && <div className="source-body">
        <label className="file-button">Excel 파일 선택<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={event => { const next = event.currentTarget.files?.[0] ?? null; selectFile(next); if (next) void inspectExcel(next); }} /></label>
        {file && <span className="selected-file">{file.name}</span>}
        {sheets.length > 0 && <div className="excel-options">
          <label>시트<select value={sheetName} onChange={event => setSheetName(event.target.value)}>{sheets.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
          <label>앞면 열<select value={keyColumn} onChange={event => setKeyColumn(Number(event.target.value))}>{(selectedSheet?.columns ?? []).map(column =>
            <option key={column.index} value={column.index}>{column.name}</option>)}</select></label>
          <fieldset><legend>뒷면 열 (최대 6개)</legend>{(selectedSheet?.columns ?? []).filter(column => column.index !== keyColumn).map(column =>
            <label className="column-check" key={column.index}><input type="checkbox" checked={valueColumns.includes(column.index)} disabled={!valueColumns.includes(column.index) && valueColumns.length >= 6}
              onChange={event => setValueColumns(current => event.target.checked ? [...current, column.index] : current.filter(index => index !== column.index))} />{column.name}</label>)}</fieldset>
          <p className="hint">수식이 포함된 셀은 실행하지 않으며 해당 파일을 가져오지 않습니다.</p>
        </div>}
      </div>}
      <label className="title-field">콘텐츠 제목<Input maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="예: 와인 기초 정리" /></label>
    </Card>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="import-actions"><Button variant="outline" onClick={onCancel}>취소</Button>
      <Button disabled={busy || (mode === 'EXCEL' && !sheets.length)} onClick={() => void prepare()}>{busy ? '읽는 중…' : '카드 미리보기'}</Button></div>
  </main>;
}
