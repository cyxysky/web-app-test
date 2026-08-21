import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveLibreOfficeExecutable, resolveLibreOfficeOfficeWorker, resolveLibreOfficePythonExecutable } from '@/server/files/libreoffice';
import { generateFileBuffer } from './document-artifact-generators';
import { renderBrowserChatAttachmentVisuals } from './browser-chat-attachment-visuals';

async function officeGenerationAvailable() {
  const executable = await resolveLibreOfficeExecutable();
  return Boolean(executable && await resolveLibreOfficePythonExecutable(executable) && await resolveLibreOfficeOfficeWorker());
}

test('renders selected PDF pages into model-ready PNG files', async (context) => {
  if (!await officeGenerationAvailable()) return context.skip('LibreOffice UNO generation is not available in this environment.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-attachment-visual-'));
  const sourcePath = path.join(root, 'source.pdf');
  const generated = await generateFileBuffer({
    blocks: Array.from({ length: 140 }, (_, index) => ({ id: `paragraph-${index}`, type: 'text', text: `Paragraph ${index + 1}: enough content to verify exact PDF page selection.` })),
    document: { title: 'Attachment visual pages' }, documentType: 'word', fileName: 'source.pdf',
  });
  await writeFile(sourcePath, generated.buffer);
  try {
    const result = await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.pdf', name: 'source.pdf', pages: [2], previewRoot: path.join(root, 'previews') });
    assert.equal(result.renderer, 'pdf');
    assert.ok((result.pageCount ?? 0) >= 2);
    assert.deepEqual(result.renderedPages, [2]);
    assert.equal((await readFile(result.imagePaths[0])).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('renders a LibreOffice-generated DOCX into visual pages without detaching the source', async (context) => {
  if (!await officeGenerationAvailable()) return context.skip('LibreOffice UNO generation is not available in this environment.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-docx-visual-'));
  const sourcePath = path.join(root, 'template.docx');
  const generated = await generateFileBuffer({
    blocks: [{ id: 'overview', type: 'heading', text: '工作概览' }, { id: 'body', type: 'text', text: '本年度研发工作按计划推进。' }],
    document: { title: '研发部员工年中工作总结报告' }, documentType: 'word', fileName: 'template.docx',
  });
  await writeFile(sourcePath, generated.buffer);
  try {
    const result = await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.docx', name: 'template.docx', pages: [1], previewRoot: path.join(root, 'previews') });
    assert.ok(result.renderer === 'html-preview' || result.renderer === 'libreoffice-pdf', result.warning);
    assert.deepEqual(result.renderedPages, [1]);
    assert.equal((await readFile(result.imagePaths[0])).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
