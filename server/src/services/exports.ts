import ExcelJS from 'exceljs';
import type { Flashcard } from '../../../shared/schemas/index.js';

function escapeTsv(value: string) {
  return /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}
export function exportTsv(cards: Flashcard[]): string {
  return [
    ['key_text', 'value_1', 'value_2', 'value_3', 'value_4', 'value_5', 'value_6'].join('\t'),
    ...cards.map(card => [card.key, ...card.values, ...Array(Math.max(0, 6 - card.values.length)).fill('')].map(escapeTsv).join('\t')),
  ].join('\r\n');
}
export async function exportXlsx(cards: Flashcard[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Flashcards');
  sheet.addRow(['key_text', 'value_1', 'value_2', 'value_3', 'value_4', 'value_5', 'value_6']);
  for (const card of cards) sheet.addRow([card.key, ...card.values, ...Array(Math.max(0, 6 - card.values.length)).fill('')]);
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach(column => { column.width = 24; });
  sheet.eachRow(row => row.eachCell(cell => { cell.numFmt = '@'; }));
  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes);
}
