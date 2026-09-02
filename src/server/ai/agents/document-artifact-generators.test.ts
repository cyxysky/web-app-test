import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFileBuffer, resolveLibreOfficeExecutable } from '@webpilot/capability-file/node';

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

test('requires a saved program draft for Office outputs', async () => {
  await assert.rejects(
    generateFileBuffer({ blocks: [], document: {}, documentType: 'word', fileName: 'report.docx' }),
    /saved source draft/,
  );
});

test('routes Office output through the direct UNO program worker', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const result = await generateFileBuffer({
    blocks: [], document: {}, documentType: 'spreadsheet', fileName: 'results.xlsx',
    generator: 'uno',
    program: `
def create_document(job):
    document = job.spreadsheet('document')
    sheet = document.sheet('results', 'Results')
    sheet.set_range('values', 'A1', [['Result', 'Passed']])
    document.save()
    document.close()
`,
  });
  assert.ok(result.buffer.byteLength > 64);
  assert.ok(result.previewPdf && result.previewPdf.byteLength > 64);
  assert.equal((result.diagnostics as { renderer?: string }).renderer, 'libreoffice-uno');
});
