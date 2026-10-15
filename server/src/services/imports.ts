import ExcelJS from 'exceljs';
import { FlashcardSchema, type Flashcard } from '../../../shared/schemas/index.js';

export type SourceMode = 'PHOTO' | 'TEXT' | 'EXCEL';
export type ImportIssue = { row: number; message: string };
export type CardImport = { cards: Flashcard[]; issues: ImportIssue[] };
export type ColumnMapping = { keyColumn: number; valueColumns: number[] };

const MAX_CARDS = 500;
const MAX_COLUMNS = 16;
const MAX_TEXT_LENGTH = 2_000_000;
const headers = new Set(['key', 'key_text', 'front', 'question', 'term', 'word', '앞면', '질문', '단어']);

function cellString(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if ('formula' in value || 'sharedFormula' in value) throw new Error('수식 셀은 가져올 수 없습니다. 수식 결과를 값으로 붙여넣어 주세요.');
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  if ('text' in value && typeof value.text === 'string') return value.text;
  return '';
}

function normalizeHeader(value: string) { return value.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_'); }

function parseDelimitedRows(text: string): string[][] {
  if (text.length > MAX_TEXT_LENGTH) throw new Error('텍스트 파일은 2MB 이하만 가져올 수 있습니다.');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : firstLine.includes(';') ? ';' : '\t';
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some(value => value.length) || rows.length === 0) rows.push(row);
  return rows;
}

function parseRows(rows: string[][], mapping?: ColumnMapping): CardImport {
  if (rows.length > MAX_CARDS + 1) throw new Error('한 파일에 카드를 500개까지만 가져올 수 있습니다.');
  const first = rows[0] ?? [];
  const keyHeader = first.findIndex(value => headers.has(normalizeHeader(value)));
  const hasHeader = keyHeader >= 0;
  const start = hasHeader ? 1 : 0;
  const keyColumn = mapping?.keyColumn ?? (hasHeader ? keyHeader + 1 : 1);
  const valueColumns = mapping?.valueColumns ?? first.map((_, index) => index + 1).filter(index => index !== keyColumn);
  if (keyColumn < 1 || keyColumn > MAX_COLUMNS || valueColumns.some(index => index < 1 || index > MAX_COLUMNS || index === keyColumn) || valueColumns.length > 6) {
    throw new Error('열 선택은 앞면 1개와 뒷면 최대 6개까지 가능합니다.');
  }
  const cards: Flashcard[] = [], issues: ImportIssue[] = [];
  rows.slice(start).forEach((row, offset) => {
    const rowNumber = start + offset + 1;
    if (row.every(value => !value.trim())) return;
    const key = row[keyColumn - 1] ?? '';
    const values = valueColumns.map(index => row[index - 1] ?? '').map(value => value.trim()).filter(Boolean);
    const result = FlashcardSchema.safeParse({ key, values });
    if (!result.success) {
      issues.push({ row: rowNumber, message: !key.trim() ? '앞면이 비어 있습니다.' : !values.length ? '뒷면 값이 최소 1개 필요합니다.' : '카드 글자 수나 뒷면 값 개수를 확인해 주세요.' });
      return;
    }
    if (cards.some(card => card.key.toLocaleLowerCase() === result.data.key.toLocaleLowerCase())) {
      issues.push({ row: rowNumber, message: '앞면이 중복됩니다.' });
      return;
    }
    cards.push(result.data);
  });
  return { cards, issues };
}

export function parseTextImport(text: string): CardImport {
  return parseRows(parseDelimitedRows(text.replace(/^\uFEFF/, '')));
}

function cellRows(sheet: ExcelJS.Worksheet): string[][] {
  if (sheet.rowCount > MAX_CARDS + 1) throw new Error('한 파일에 카드를 500개까지만 가져올 수 있습니다.');
  if (sheet.columnCount > MAX_COLUMNS) throw new Error('시트는 최대 16개 열까지만 지원합니다.');
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    const values: string[] = [];
    for (let col = 1; col <= Math.max(1, sheet.columnCount); col++) values.push(cellString(row.getCell(col).value));
    rows.push(values);
  });
  return rows;
}

function validateXlsxArchive(bytes: Buffer) {
  const floor = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let i = bytes.length - 22; i >= floor; i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('정상적인 XLSX 압축 파일이 아닙니다.');
  const entryCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (entryCount < 1 || entryCount > 2_000 || offset + directorySize > end) throw new Error('Excel 파일 구성이 지원 범위를 벗어납니다.');
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Excel 압축 파일이 손상되었습니다.');
    const flags = bytes.readUInt16LE(offset + 8);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').toLowerCase();
    if ((flags & 1) !== 0 || name.endsWith('vbaproject.bin')) throw new Error('암호화되거나 매크로가 포함된 파일은 가져올 수 없습니다.');
    expandedBytes += expanded;
    if (expanded > 10 * 1024 * 1024 || expandedBytes > 25 * 1024 * 1024) throw new Error('압축 해제 크기가 허용 한도를 초과했습니다.');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
async function loadWorkbook(bytes: Buffer) {
  if (bytes.byteLength < 4 || bytes.subarray(0, 2).toString('hex') !== '504b') throw new Error('정상적인 XLSX 파일이 아닙니다.');
  validateXlsxArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  if (!workbook.worksheets.length) throw new Error('통합 문서에 시트가 없습니다.');
  return workbook;
}

export async function inspectWorkbook(bytes: Buffer) {
  const workbook = await loadWorkbook(bytes);
  return workbook.worksheets.map(sheet => {
    const rows = cellRows(sheet);
    return {
      name: sheet.name,
      columns: (rows[0] ?? []).map((name, index) => ({ index: index + 1, name: name || '열 ' + (index + 1) })),
      preview: rows.slice(0, 6),
    };
  });
}

export async function parseWorkbook(bytes: Buffer, sheetName?: string, mapping?: ColumnMapping): Promise<CardImport> {
  const workbook = await loadWorkbook(bytes);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error('선택한 시트를 찾을 수 없습니다.');
  return parseRows(cellRows(sheet), mapping);
}

export function decodeUtf8(bytes: Buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('UTF-8 텍스트 파일만 지원합니다.'); }
}
