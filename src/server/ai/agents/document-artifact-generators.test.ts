import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { readBrowserChatAttachment } from './browser-chat-attachment-reader';
import { generateFileBuffer } from './document-artifact-generators';

test('generates text files using an explicit supported extension', async () => {
  const result = await generateFileBuffer({ fileName: 'result.json', content: '{"ok":true}' });
  assert.equal(result.extension, '.json');
  assert.equal(result.buffer.toString('utf8'), '{"ok":true}\n');
  await assert.rejects(
    generateFileBuffer({ fileName: 'unsafe.exe', content: 'not executable' }),
    /Unsupported output extension/,
  );
});

test('generates a readable Word document', async () => {
  const result = await generateFileBuffer({
    fileName: 'report.docx',
    content: '# 测试报告\n\n- 已完成登录验证\n- 未发现阻塞问题',
  });
  const text = (await mammoth.extractRawText({ buffer: result.buffer })).value;
  assert.match(text, /测试报告/);
  assert.match(text, /已完成登录验证/);
});

test('generates a readable Excel workbook with multiple value types', async () => {
  const result = await generateFileBuffer({
    fileName: 'results.xlsx',
    sheets: [{ name: '执行结果', rows: [['用例', '通过'], ['登录', true], ['耗时', 12.5]] }],
  });
  const workbook = XLSX.read(result.buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['执行结果']);
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets['执行结果'], { header: 1 }), [
    ['用例', '通过'],
    ['登录', true],
    ['耗时', 12.5],
  ]);
});

test('generates a real BIFF8 .xls workbook', async () => {
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

test('rejects .xls worksheets that exceed BIFF8 column limits', async () => {
  await assert.rejects(
    generateFileBuffer({
      fileName: 'too-wide.xls',
      sheets: [{ rows: [Array.from({ length: 257 }, (_, index) => index)] }],
    }),
    /256 column BIFF8 limit/,
  );
});

test('generates a real PowerPoint package with slide content', async () => {
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

test('generates a PDF with embedded Chinese text', async () => {
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

test('generates PDF without loading PDFKit Helvetica AFM from its bundle directory', async () => {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof filePath === 'string' && /[\\/]data[\\/]Helvetica\.afm$/i.test(filePath)) {
      throw new Error(`Unexpected PDFKit standard-font lookup: ${filePath}`);
    }
    return originalReadFileSync(filePath, ...args as Parameters<typeof originalReadFileSync> extends [unknown, ...infer Rest] ? Rest : never);
  }) as typeof fs.readFileSync;
  try {
    const result = await generateFileBuffer({
      fileName: 'bundled-runtime.pdf',
      content: '# Bundled PDF\n\nThis PDF uses an explicitly embedded font.',
    });
    assert.equal(result.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('conversation reader can read back every generated special format', async () => {
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
