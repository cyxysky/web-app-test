import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFileBuffer } from './document-artifact-generators';
import { resolveLibreOfficeExecutable } from '@/server/files/libreoffice';

test('generates plain text and delimited data without treating them as Office documents', async () => {
  const json = await generateFileBuffer({
    blocks: [{ id: 'body', type: 'text', text: '{"ok":true}' }],
    document: {}, documentType: 'word', fileName: 'result.json',
  });
  assert.equal(json.buffer.toString('utf8'), '{"ok":true}\n');

  const csv = await generateFileBuffer({
    blocks: [{ id: 'table', type: 'table', rows: [['name', 'value'], ['alpha', 1]] }],
    document: {}, documentType: 'spreadsheet', fileName: 'table.csv',
  });
  assert.match(csv.buffer.toString('utf8'), /name,value/);
});

test('requires a Python UNO draft for Office outputs', async () => {
  await assert.rejects(
    generateFileBuffer({ blocks: [], document: {}, documentType: 'word', fileName: 'report.docx' }),
    /Python UNO program/,
  );
});

test('routes Office output through the direct UNO program worker', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const result = await generateFileBuffer({
    blocks: [], document: {}, documentType: 'spreadsheet', fileName: 'results.xlsx',
    program: `
def create_document(job):
    document = job.new_document('spreadsheet')
    sheet = document.Sheets.getByIndex(0)
    sheet.getCellByPosition(0, 0).String = 'Result'
    sheet.getCellByPosition(1, 0).String = 'Passed'
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Calc MS Excel 2007 XML'),))
    job.close(document)
`,
  });
  assert.ok(result.buffer.byteLength > 64);
  assert.ok(result.previewPdf && result.previewPdf.byteLength > 64);
  assert.equal((result.diagnostics as { renderer?: string }).renderer, 'libreoffice-uno');
});
