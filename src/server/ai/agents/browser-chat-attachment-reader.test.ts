import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  extractFileTextInWorker as extractAttachmentTextInWorker,
  FILE_READ_MIN_CHARACTERS as BROWSER_CHAT_FILE_READ_MIN_CHARS,
  normalizeFileReadLimit as normalizeBrowserChatFileReadLimit,
  readFileAttachment as readBrowserChatAttachment,
} from '@webpilot/capability-file/node';

test('readFile defaults to 20000 characters and clamps smaller requested limits', () => {
  assert.equal(normalizeBrowserChatFileReadLimit(undefined), 20_000);
  assert.equal(normalizeBrowserChatFileReadLimit(300), 20_000);
  assert.equal(normalizeBrowserChatFileReadLimit(30_000), 30_000);
});

test('readFile parses text in the CPU worker and returns the requested range', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-read-file-'));
  const filePath = path.join(directory, 'large.md');
  const content = 'x'.repeat(BROWSER_CHAT_FILE_READ_MIN_CHARS + 5_000);
  await writeFile(filePath, content, 'utf8');

  try {
    const result = await readBrowserChatAttachment({
      absolutePath: filePath,
      attachment: {
        id: 'file-1',
        kind: 'file',
        name: 'large.md',
        path: 'uploads/large.md',
        type: 'text/markdown',
        url: '/api/artifacts/uploads/large.md',
      },
      limit: 300,
      offset: 100,
    });

    assert.equal(result.ok, true);
    assert.match(result.actual, /字符区间：100-20100 \/ 25000/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('CPU extraction reads source bytes inside the worker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-worker-file-'));
  const filePath = path.join(directory, 'source.txt');
  await writeFile(filePath, 'worker-owned attachment bytes', 'utf8');
  try {
    assert.equal(
      await extractAttachmentTextInWorker({ extension: '.txt', kind: 'text', path: filePath }),
      'worker-owned attachment bytes',
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('readFile reports image dimensions from the exact saved artifact bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-read-image-'));
  const filePath = path.join(directory, 'layout-source.png');
  await writeFile(filePath, await sharp({
    create: {
      width: 320,
      height: 180,
      channels: 4,
      background: { r: 24, g: 32, b: 48, alpha: 1 },
    },
  }).png().toBuffer());

  try {
    const result = await readBrowserChatAttachment({
      absolutePath: filePath,
      attachment: {
        id: 'image-layout-source',
        kind: 'image',
        name: 'layout-source.png',
        path: 'generated/layout-source.png',
        type: 'image/png',
        url: '/api/artifacts/generated/layout-source.png',
      },
    });

    assert.equal(result.ok, true, result.actual);
    assert.match(result.actual, /Dimensions: 320 x 180 px/);
    assert.match(result.actual, /Aspect ratio: 1\.777778/);
    assert.match(result.actual, /exact saved artifact bytes/i);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('reads generated line-oriented data extensions without relying on a browser MIME type', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-line-data-'));
  try {
    for (const extension of ['.jsonl', '.ndjson', '.tsv']) {
      const filePath = path.join(directory, `records${extension}`);
      await writeFile(filePath, extension === '.tsv' ? 'name\tvalue\nalpha\t1\n' : '{"name":"alpha"}\n');
      const result = await readBrowserChatAttachment({
        absolutePath: filePath,
        attachment: {
          id: `line-data-${extension}`,
          kind: 'file',
          name: path.basename(filePath),
          path: filePath,
          size: (await stat(filePath)).size,
          type: 'application/octet-stream',
          url: '',
        },
      });
      assert.equal(result.ok, true, result.actual);
      assert.match(result.actual, /alpha/);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('readFile can extract and inspect one DOCX from the same source bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-read-docx-'));
  const filePath = path.join(directory, 'template.docx');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>员工姓名</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>研发部员工年中工作总结报告</w:t></w:r></w:p><w:sectPr/>
    </w:body></w:document>`);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

  try {
    const result = await readBrowserChatAttachment({
      absolutePath: filePath,
      attachment: {
        id: 'file-template',
        kind: 'file',
        name: '研发部员工年中工作总结报告.docx',
        path: 'uploads/template.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        url: '/api/artifacts/uploads/template.docx',
      },
      includeVisuals: false,
    });

    assert.equal(result.ok, true, result.actual);
    assert.match(result.actual, /\[DOCX 模板结构\]/);
    assert.match(result.actual, /员工姓名/);
    assert.match(result.actual, /研发部员工年中工作总结报告/);
    assert.doesNotMatch(result.actual, /Corrupted zip|data length = 0/i);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
