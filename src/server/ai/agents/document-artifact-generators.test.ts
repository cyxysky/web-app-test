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

test('adds LibreOffice drawing-layer SVG to a spreadsheet without ExcelJS', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'dashboard', type: 'sheet', name: 'Dashboard', children: [
      { id: 'data', type: 'table', rows: [['Metric', 'Value'], ['Quality', 98]] },
      {
        id: 'badge',
        type: 'svg',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect width="360" height="120" rx="24" fill="#10b981"/></svg>',
        style: { position: 'absolute', x: 420, y: 40, width: 360, height: 120 },
      },
    ] }],
    document: {}, documentType: 'spreadsheet', fileName: 'dashboard.xlsx',
  });
  const archive = await JSZip.loadAsync(result.buffer);
  assert.ok(Object.keys(archive.files).some((name) => /^xl\/media\//.test(name)));
  assert.ok(Object.keys(archive.files).some((name) => /^xl\/drawings\//.test(name)));
});

test('normalizes URL-encoded inline SVG paint references and text colors', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'page', type: 'page', children: [
      {
        id: 'encoded-gradient',
        type: 'svg',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180"><defs><linearGradient id="accent"><stop stop-color="%232563eb"/><stop offset="1" stop-color="%238b5cf6"/></linearGradient></defs><rect width="640" height="180" fill="url(%23accent)"/></svg>',
        style: { x: 20, y: 20, width: 640, height: 180 },
      },
      { id: 'encoded-white', type: 'text', text: 'Visible white text', style: { x: 36, y: 78, width: 400, height: 36, color: '%23FFFFFF', fontSize: 24 } },
    ] }],
    document: { page: { width: 720, height: 260, unit: 'px' } },
    documentType: 'presentation',
    fileName: 'encoded-svg.pptx',
  });
  const archive = await JSZip.loadAsync(result.buffer);
  const slideXml = await archive.file('ppt/slides/slide1.xml')?.async('text');
  assert.match(slideXml || '', /Visible white text/);
  assert.match(slideXml || '', /FFFFFF/i);
  assert.ok(Object.keys(archive.files).some((name) => /^ppt\/media\//.test(name)));
});

test('preserves explicit presentation structure and legacy inline SVG content', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [
      { id: 'page-one', type: 'page', children: [{ id: 'title-one', type: 'text', text: 'Page one', style: { x: 40, y: 40, width: 400, height: 80 } }] },
      { id: 'page-two', type: 'page', children: [{
        id: 'svg-two',
        type: 'svg',
        content: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="#2563eb"/></svg>',
        style: { x: 40, y: 40, width: 400, height: 120 },
      }, {
        id: 'native-ellipse',
        type: 'shape',
        unoService: 'com.sun.star.drawing.EllipseShape',
        unoProperties: { RotateAngle: 1200, Shadow: true },
        style: { x: 520, y: 80, width: 160, height: 160, fill: '#f59e0b' },
      }] },
    ],
    document: { page: { width: 1280, height: 720, unit: 'px' } },
    documentType: 'presentation',
    fileName: 'structured.pptx',
  });
  const archive = await JSZip.loadAsync(result.buffer);
  assert.ok(archive.file('ppt/slides/slide1.xml'));
  assert.ok(archive.file('ppt/slides/slide2.xml'));
  assert.ok(Object.keys(archive.files).some((name) => /^ppt\/media\//.test(name)));
});

test('creates positioned Writer drawing objects through pure LibreOffice UNO', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'cover', type: 'page', children: [
      { id: 'title', type: 'heading', text: 'UNO report', style: { position: 'absolute', unit: 'mm', x: 20, y: 24, width: 150, height: 20, fontSize: 26 } },
      { id: 'accent', type: 'shape', unoService: 'com.sun.star.drawing.EllipseShape', style: { unit: 'mm', x: 145, y: 18, width: 35, height: 35, fill: 'linear-gradient(45deg, #2563eb, #8b5cf6)', opacity: 0.9 } },
    ] }],
    document: { page: { width: 210, height: 297, unit: 'mm' } },
    documentType: 'word',
    fileName: 'uno-report.docx',
  });
  const archive = await JSZip.loadAsync(result.buffer);
  assert.ok(archive.file('word/document.xml'));
  assert.match(await archive.file('word/document.xml')!.async('text'), /UNO report/);
});

test('generates PDF directly from a free block tree', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    blocks: [{ id: 'title', type: 'heading', text: 'Test summary', level: 1 }, { id: 'metric', type: 'metric', items: [{ label: 'Passed', value: 42 }] }],
    document: { page: { marginLeft: 18, marginRight: 18 } }, documentType: 'word', fileName: 'summary.pdf',
  });
  assert.equal(result.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});
