import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { extractAttachmentTextInWorker } from '@/server/runtime/cpu-worker-pool';
import { readBrowserChatAttachment } from './browser-chat-attachment-reader';
import { BROWSER_CHAT_FILE_READ_MIN_CHARS, normalizeBrowserChatFileReadLimit } from './browser-chat-file-read';

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

test('CPU extraction does not detach the caller Buffer', async () => {
  const source = Buffer.from('caller-owned attachment bytes', 'utf8');
  const original = Buffer.from(source);
  assert.equal(await extractAttachmentTextInWorker({ buffer: source, extension: '.txt', kind: 'text' }), original.toString('utf8'));
  assert.equal(source.byteLength, original.byteLength);
  assert.deepEqual(source, original);
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
