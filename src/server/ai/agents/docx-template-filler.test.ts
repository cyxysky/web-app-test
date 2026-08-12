import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { fillDocxTemplateBuffer, inspectDocxTemplateBuffer } from './docx-template-filler';

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:tbl><w:tr>
    <w:tc><w:p><w:r><w:t>员工姓名</w:t></w:r></w:p></w:tc>
    <w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:tc>
  </w:tr></w:tbl>
  <w:p><w:r><w:t>工作总结</w:t></w:r></w:p>
  <w:p><w:pPr><w:spacing w:line="360"/></w:pPr></w:p>
  <w:p><w:r><w:t>日期：</w:t></w:r><w:r><w:t>2026-</w:t></w:r><w:r><w:t>08-12</w:t></w:r></w:p>
</w:body></w:document>`;

async function templateBuffer() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('_rels/.rels', '<Relationships/>');
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="KeepMe"/></w:styles>');
  zip.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>固定页眉</w:t></w:r></w:p></w:hdr>');
  zip.file('word/footer1.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>固定页脚</w:t></w:r></w:p></w:ftr>');
  zip.file('word/comments.xml', '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>填写说明</w:t></w:r></w:p></w:comment></w:comments>');
  zip.file('word/media/logo.png', Buffer.from('not-decoded-during-structure-inspection'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('fills exact DOCX template slots while preserving unrelated package parts', async () => {
  const template = await templateBuffer();
  const original = await JSZip.loadAsync(template);
  const result = await fillDocxTemplateBuffer(template, [
    { anchor: '员工姓名', content: '张三', target: 'nextCell' },
    { anchor: '工作总结', content: '完成核心功能\n修复关键缺陷', target: 'followingParagraph' },
    { anchor: '2026-08-12', content: '2026-08-13', target: 'replaceText' },
  ]);
  const output = await JSZip.loadAsync(result.buffer);
  const xml = await output.file('word/document.xml')!.async('string');
  assert.match(xml, /张三/);
  assert.match(xml, /完成核心功能/);
  assert.match(xml, /<w:br\/>/);
  assert.match(xml, /2026-08-13/);
  assert.doesNotMatch(xml, /2026-08-12/);
  assert.equal(
    await output.file('word/styles.xml')!.async('string'),
    await original.file('word/styles.xml')!.async('string'),
  );
  assert.equal(
    await output.file('word/header1.xml')!.async('string'),
    await original.file('word/header1.xml')!.async('string'),
  );
  assert.deepEqual(result.changedParts, ['word/document.xml']);
  assert.equal(result.filledOperations, 3);
});

test('reports template table slots and rejects ambiguous anchors', async () => {
  const template = await templateBuffer();
  const inspection = await inspectDocxTemplateBuffer(template);
  assert.equal(inspection.tableCount, 1);
  assert.equal(inspection.headerCount, 1);
  assert.equal(inspection.footerCount, 1);
  assert.equal(inspection.commentCount, 1);
  assert.equal(inspection.mediaCount, 1);
  assert.deepEqual(inspection.headerTexts, ['固定页眉']);
  assert.deepEqual(inspection.footerTexts, ['固定页脚']);
  assert.deepEqual(inspection.commentTexts, ['填写说明']);
  assert.deepEqual(inspection.mediaParts, ['word/media/logo.png']);
  assert.deepEqual(inspection.rows[0].cells, ['员工姓名', '']);
  await assert.rejects(
    fillDocxTemplateBuffer(template, [
      { anchor: '不存在', content: '值', target: 'nextCell' },
    ]),
    /anchor was not found/,
  );
});
