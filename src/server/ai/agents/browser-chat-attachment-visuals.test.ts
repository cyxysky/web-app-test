import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { renderBrowserChatAttachmentVisuals } from './browser-chat-attachment-visuals';

function pdfBuffer() {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    document.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.addPage().fontSize(24).text('Attachment visual page one');
    document.addPage().fontSize(24).text('Attachment visual page two');
    document.end();
  });
}

test('renders selected PDF pages into model-ready PNG files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-attachment-visual-'));
  const sourcePath = path.join(root, 'source.pdf');
  const buffer = await pdfBuffer();
  await writeFile(sourcePath, buffer);

  try {
    const result = await renderBrowserChatAttachmentVisuals({
      absolutePath: sourcePath,
      buffer,
      extension: '.pdf',
      name: 'source.pdf',
      pages: [2],
      previewRoot: path.join(root, 'previews'),
    });

    assert.equal(result.renderer, 'pdf');
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.renderedPages, [2]);
    assert.equal(result.imagePaths.length, 1);
    const image = await readFile(result.imagePaths[0]);
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('renders DOCX text and embedded images into visual pages without detaching the source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-docx-visual-'));
  const sourcePath = path.join(root, 'template.docx');
  const logo = await sharp({
    create: { width: 80, height: 40, channels: 4, background: { r: 28, g: 125, b: 86, alpha: 1 } },
  }).png().toBuffer();
  const buffer = await Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: '研发部员工年中工作总结报告', bold: true })] }),
        new Paragraph({ children: [new ImageRun({ data: logo, transformation: { width: 80, height: 40 }, type: 'png' })] }),
      ],
    }],
  }));
  await writeFile(sourcePath, buffer);

  try {
    const result = await renderBrowserChatAttachmentVisuals({
      absolutePath: sourcePath,
      buffer,
      extension: '.docx',
      name: 'template.docx',
      pages: [1],
      previewRoot: path.join(root, 'previews'),
    });

    assert.ok(result.renderer === 'html-preview' || result.renderer === 'libreoffice-pdf', result.warning);
    assert.deepEqual(result.renderedPages, [1]);
    assert.equal(result.imagePaths.length, 1);
    const image = await readFile(result.imagePaths[0]);
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(buffer.byteLength > 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
