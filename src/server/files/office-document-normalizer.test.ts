import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeOfficeDocumentSpec,
  validateOfficeDocumentStructure,
} from './office-document-normalizer';
import type { OfficeDocumentSpec } from './office-document-spec';

test('normalizes legacy visual fields without discarding the original free-form style', () => {
  const input: OfficeDocumentSpec = {
    blocks: [{
      id: 'slide',
      type: 'page',
      children: [{
        id: 'visual',
        type: 'svg',
        content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        style: { fill: '#123456', text: 'Caption', textAlign: 'center', x: 10 },
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
  assert.equal(visual?.style?.backgroundColor, '#123456');
  assert.equal(visual?.style?.align, 'center');
  assert.equal(visual?.style?.x, 10);
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
