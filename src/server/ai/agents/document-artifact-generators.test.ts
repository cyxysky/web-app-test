import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  resolveLibreOfficeExecutable,
  resolveLibreOfficeOfficeWorker,
  resolveLibreOfficePythonExecutable,
} from '@/server/files/libreoffice';
import { generateFileBuffer } from './document-artifact-generators';

async function requireOfficeGeneration(context: TestContext) {
  const executable = await resolveLibreOfficeExecutable();
  const ready = Boolean(executable && await resolveLibreOfficePythonExecutable(executable) && await resolveLibreOfficeOfficeWorker());
  if (!ready) context.skip('LibreOffice UNO generation is not available in this environment.');
  return ready;
}

test('generates text and delimited files from blocks', async () => {
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
  await assert.rejects(generateFileBuffer({ blocks: [], document: {}, documentType: 'word', fileName: 'unsafe.exe' }), /Unsupported output extension/);
});

test('keeps only real .xls format limits', async () => {
  await assert.rejects(generateFileBuffer({
    blocks: [{ id: 'wide', type: 'table', rows: [Array.from({ length: 257 }, (_, index) => index)] }],
    document: {}, documentType: 'spreadsheet', fileName: 'too-wide.xls',
  }), /256 column BIFF8 limit/);
});

test('generates a spreadsheet from sheet and table blocks', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'sheet', type: 'sheet', name: 'Results', children: [{ id: 'data', type: 'table', rows: [['Case', 'Passed'], ['Login', true]] }] }],
    document: {}, documentType: 'spreadsheet', fileName: 'results.xlsx',
  });
  const workbook = XLSX.read(result.buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Results']);
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.Results, { header: 1 }), [['Case', 'Passed'], ['Login', true]]);
});

test('generates presentation pages with freely positioned block content', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'page', type: 'page', children: [
      { id: 'title', type: 'heading', text: 'Release plan', style: { x: 20, y: 16, width: 280, height: 28, fontSize: 26 } },
      { id: 'card', type: 'card', text: 'Regression complete', style: { x: 20, y: 60, width: 140, height: 70, backgroundColor: '#eef2ff' } },
    ] }],
    document: {}, documentType: 'presentation', fileName: 'plan.pptx',
  });
  const archive = await JSZip.loadAsync(result.buffer);
  const slideXml = await archive.file('ppt/slides/slide1.xml')?.async('text');
  assert.match(slideXml || '', /Release plan/);
  assert.match(slideXml || '', /Regression complete/);
});

test('generates PDF directly from a free block tree', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'title', type: 'heading', text: 'Test summary', level: 1 }, { id: 'metric', type: 'metric', items: [{ label: 'Passed', value: 42 }] }],
    document: { page: { marginLeft: 18, marginRight: 18 } }, documentType: 'word', fileName: 'summary.pdf',
  });
  assert.equal(result.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});
