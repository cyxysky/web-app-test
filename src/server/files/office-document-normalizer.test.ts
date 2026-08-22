import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeOfficeDocumentSpec,
  validateCanonicalOfficeBlockInput,
  validateOfficeDocumentStructure,
} from './office-document-normalizer';
import type { OfficeDocumentSpec } from './office-document-spec';

test('preserves canonical visual fields without rewriting their meaning', () => {
  const input: OfficeDocumentSpec = {
    blocks: [{
      id: 'slide',
      type: 'page',
      children: [{
        id: 'visual',
        type: 'svg',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        text: 'Caption',
        style: { align: 'center', fill: '#123456', x: 10 },
      }],
    }],
    document: {},
    documentType: 'presentation',
    fileName: 'visual.pptx',
  };
  const normalized = normalizeOfficeDocumentSpec(input);
  const visual = normalized.blocks[0].children?.[0];
  assert.equal(visual?.svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(visual?.text, 'Caption');
  assert.equal(visual?.style?.fill, '#123456');
  assert.equal(visual?.style?.align, 'center');
  assert.equal(visual?.style?.x, 10);
});

test('rejects flattened style fields instead of guessing which value the model intended', () => {
  assert.throws(() => validateCanonicalOfficeBlockInput({
    id: 'title',
    type: 'text',
    fontSize: 22,
    style: { fontSize: 28 },
    text: 'Title',
  }), /block\.fontSize.*use block\.style\.fontSize/);
});

test('rejects semantic aliases instead of silently rewriting them', () => {
  assert.throws(() => validateCanonicalOfficeBlockInput({
    id: 'visual',
    type: 'svg',
    content: '<svg/>',
  }), /block\.content.*use block\.svg/);
});

test('requires explicit presentation pages and spreadsheet sheets', () => {
  assert.throws(() => validateOfficeDocumentStructure({
    blocks: [{ id: 'orphan', type: 'text', text: 'orphan' }],
    document: {},
    documentType: 'presentation',
    fileName: 'orphan.pptx',
  }, '.pptx'), /top-level page blocks/);
  assert.throws(() => validateOfficeDocumentStructure({
    blocks: [{ id: 'orphan', type: 'table', rows: [['value']] }],
    document: {},
    documentType: 'spreadsheet',
    fileName: 'orphan.xlsx',
  }, '.xlsx'), /top-level sheet blocks/);
});
