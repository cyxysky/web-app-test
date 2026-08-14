import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  resolveLibreOfficeExecutable,
  resolveLibreOfficeOfficeWorker,
  resolveLibreOfficePythonExecutable,
} from '@/server/files/libreoffice';
import { readBrowserChatAttachment } from './browser-chat-attachment-reader';
import { generateFileBuffer } from './document-artifact-generators';

async function requireOfficeGeneration(context: TestContext) {
  const executable = await resolveLibreOfficeExecutable();
  const ready = Boolean(
    executable
    && await resolveLibreOfficePythonExecutable(executable)
    && await resolveLibreOfficeOfficeWorker()
  );
  if (!ready) context.skip('LibreOffice UNO generation is not available in this environment.');
  return ready;
}

test('generates text files using an explicit supported extension', async () => {
  const result = await generateFileBuffer({ fileName: 'result.json', content: '{"ok":true}' });
  assert.equal(result.extension, '.json');
  assert.equal(result.buffer.toString('utf8'), '{"ok":true}\n');
  await assert.rejects(
    generateFileBuffer({ fileName: 'unsafe.exe', content: 'not executable' }),
    /Unsupported output extension/,
  );
});

test('generates a readable Word document with an explicit visual theme', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    fileName: 'report.docx',
    theme: { preset: 'professional' },
    content: '# 测试报告\n\n- 已完成登录验证\n- 未发现阻塞问题',
  });
  const text = (await mammoth.extractRawText({ buffer: result.buffer })).value;
  assert.match(text, /测试报告/);
  assert.match(text, /已完成登录验证/);
  const archive = await JSZip.loadAsync(result.buffer);
  const documentXml = await archive.file('word/document.xml')?.async('text') || '';
  assert.match(documentXml, /w:color w:val="1F4E78"/i);
});

test('generates a readable and styled Excel workbook with multiple value types', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    fileName: 'results.xlsx',
    sheets: [{ name: '执行结果', rows: [['用例', '通过'], ['登录', true], ['耗时', 12.5]] }],
  });
  const workbook = XLSX.read(result.buffer, { type: 'buffer', cellStyles: true });
  assert.deepEqual(workbook.SheetNames, ['执行结果']);
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets['执行结果'], { header: 1 }), [
    ['用例', '通过'],
    ['登录', true],
    ['耗时', 12.5],
  ]);
  assert.equal(workbook.Sheets['执行结果'].A1.s?.fgColor?.rgb, '1F4E78');
});

test('generates a real BIFF8 .xls workbook', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    fileName: 'legacy-results.xls',
    sheets: [{ name: 'Legacy', rows: [['Case', 'Passed'], ['Login', true], ['Duration', 12.5]] }],
  });
  assert.equal(result.extension, '.xls');
  assert.equal(result.buffer.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
  const workbook = XLSX.read(result.buffer, { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.Legacy, { header: 1 }), [
    ['Case', 'Passed'],
    ['Login', true],
    ['Duration', 12.5],
  ]);
});

test('generates CSV and TSV from structured sheet rows', async () => {
  const csv = await generateFileBuffer({
    fileName: 'table.csv',
    sheets: [{ rows: [['name', 'value'], ['alpha', 1]] }],
  });
  const tsv = await generateFileBuffer({
    fileName: 'table.tsv',
    sheets: [{ rows: [['name', 'value'], ['alpha', 1]] }],
  });
  assert.match(csv.buffer.toString('utf8'), /name,value/);
  assert.match(tsv.buffer.toString('utf8'), /name\tvalue/);
});

test('rejects .xls worksheets that exceed BIFF8 column limits', async () => {
  await assert.rejects(
    generateFileBuffer({
      fileName: 'too-wide.xls',
      sheets: [{ rows: [Array.from({ length: 257 }, (_, index) => index)] }],
    }),
    /256 column BIFF8 limit/,
  );
});

test('generates a real PowerPoint package with slide content', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    fileName: 'plan.pptx',
    title: '发布计划',
    slides: [{ title: '第一阶段', bullets: ['完成开发', '执行回归测试'] }],
  });
  const archive = await JSZip.loadAsync(result.buffer);
  const slideXml = await archive.file('ppt/slides/slide1.xml')?.async('text');
  assert.match(slideXml || '', /第一阶段/);
  assert.match(slideXml || '', /执行回归测试/);
});

test('generates a PDF with embedded Chinese text', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const result = await generateFileBuffer({
    fileName: 'summary.pdf',
    content: '# 测试总结\n\n对话文件生成能力已完成。',
  });
  assert.equal(result.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: result.buffer });
  try {
    const text = (await parser.getText()).text;
    assert.match(text, /测试总结/);
    assert.match(text, /文件生成能力已完成/);
  } finally {
    await parser.destroy();
  }
});

test('conversation reader can read back every generated special format', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-generated-readback-'));
  try {
    const outputs = [
      await generateFileBuffer({ fileName: 'report.docx', content: '# Word 回读\n\n内容完整。' }),
      await generateFileBuffer({ fileName: 'report.pdf', content: '# PDF 回读\n\n内容完整。' }),
      await generateFileBuffer({ fileName: 'report.xlsx', sheets: [{ rows: [['Excel 回读'], ['内容完整']] }] }),
      await generateFileBuffer({ fileName: 'report.pptx', slides: [{ title: 'PPT 回读', bullets: ['内容完整'] }] }),
    ];
    const expected = ['Word 回读', 'PDF 回读', 'Excel 回读', 'PPT 回读'];
    for (const [index, output] of outputs.entries()) {
      const fileName = `report${output.extension}`;
      const filePath = path.join(directory, fileName);
      await writeFile(filePath, output.buffer);
      const read = await readBrowserChatAttachment({
        absolutePath: filePath,
        attachment: {
          id: `generated-${index}`,
          kind: 'file',
          name: fileName,
          path: filePath,
          size: output.buffer.byteLength,
          type: 'application/octet-stream',
          url: '',
        },
        limit: 40_000,
      });
      assert.equal(read.ok, true, read.actual);
      assert.match(read.actual, new RegExp(expected[index]));
      assert.match(read.actual, /内容完整/);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('LibreOffice-backed legacy and OpenDocument outputs are real readable files', async (context) => {
  if (!await requireOfficeGeneration(context)) return;
  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-generated-libreoffice-'));
  try {
    const inputs = [
      { fileName: 'report.doc', content: '# Legacy Word\n\nReadable body' },
      { fileName: 'report.odt', content: '# OpenDocument Word\n\nReadable body' },
      { fileName: 'report.ods', sheets: [{ rows: [['OpenDocument Sheet'], ['Readable body']] }] },
      { fileName: 'report.ppt', slides: [{ title: 'Legacy Slides', bullets: ['Readable body'] }] },
      { fileName: 'report.odp', slides: [{ title: 'OpenDocument Slides', bullets: ['Readable body'] }] },
    ];
    for (const [index, input] of inputs.entries()) {
      const output = await generateFileBuffer(input);
      assert.ok(output.buffer.byteLength > 128, `${input.fileName} should contain a real document`);
      const filePath = path.join(directory, input.fileName);
      await writeFile(filePath, output.buffer);
      const read = await readBrowserChatAttachment({
        absolutePath: filePath,
        attachment: {
          id: `libreoffice-${index}`,
          kind: 'file',
          name: input.fileName,
          path: filePath,
          size: output.buffer.byteLength,
          type: 'application/octet-stream',
          url: '',
        },
        includeVisuals: false,
        limit: 40_000,
      });
      assert.equal(read.ok, true, read.actual);
      assert.match(read.actual, /Readable body/);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
