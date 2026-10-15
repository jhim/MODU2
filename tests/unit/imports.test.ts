import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { exportTsv, exportXlsx } from '../../server/src/services/exports.js';
import { decodeUtf8, inspectWorkbook, parseTextImport, parseWorkbook } from '../../server/src/services/imports.js';

describe('MODU2 file import/export', () => {
  it('round-trips tab-separated text with quoted tabs and multiple answers', () => {
    const cards = [{ key: 'red\twine', values: ['레드 와인', '포도\n발효'] }, { key: 'book', values: ['책', '도서'] }];
    const parsed = parseTextImport(exportTsv(cards));
    expect(parsed).toEqual({ cards, issues: [] });
  });
  it('reports invalid and duplicate rows while skipping empty lines', () => {
    const parsed = parseTextImport('key_text\tvalue_1\n\nApple\t사과\napple\t중복\n빈칸\t');
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.issues.map(issue => issue.row)).toEqual([4, 5]);
  });
  it('rejects malformed UTF-8', () => {
    expect(() => decodeUtf8(Buffer.from([0xc3, 0x28]))).toThrow('UTF-8');
  });
  it('round-trips XLSX cards and enumerates worksheets', async () => {
    const cards = [{ key: 'apple', values: ['사과', '과일'] }, { key: 'book', values: ['책'] }];
    const bytes = await exportXlsx(cards);
    const sheets = await inspectWorkbook(bytes);
    expect(sheets.map(sheet => sheet.name)).toEqual(['Flashcards']);
    expect(sheets[0]?.columns.map(column => column.name)[0]).toBe('key_text');
    expect(await parseWorkbook(bytes, 'Flashcards')).toEqual({ cards, issues: [] });
  });
  it('does not evaluate or import formula cells', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Formula');
    sheet.addRow(['key_text', 'value_1']);
    sheet.addRow(['x', { formula: '1+1' }]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseWorkbook(bytes, 'Formula')).rejects.toThrow('수식 셀');
  });
});
