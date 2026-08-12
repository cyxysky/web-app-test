import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactContentType,
  fileFormatForExtension,
  uploadStorageExtension,
  webPilotFileFormats,
} from './file-format-registry';

test('every generated format is readable and has an explicit response MIME type', () => {
  const generated = webPilotFileFormats.filter((format) => format.canGenerate);
  assert.ok(generated.length > 0);
  for (const format of generated) {
    assert.equal(format.canRead, true, `${format.extension} must be readable after generation`);
    assert.notEqual(artifactContentType(`result${format.extension}`), 'application/octet-stream', `${format.extension} needs an explicit MIME type`);
  }
});

test('generated line-oriented data formats are registered as readable text', () => {
  for (const extension of ['.jsonl', '.ndjson', '.tsv']) {
    assert.equal(fileFormatForExtension(extension)?.kind, 'text');
    assert.equal(fileFormatForExtension(extension)?.canGenerate, true);
    assert.equal(fileFormatForExtension(extension)?.canRead, true);
  }
});

test('upload storage preserves real image formats instead of renaming bytes to png', () => {
  assert.equal(uploadStorageExtension('diagram.svg', 'image/svg+xml'), '.svg');
  assert.equal(uploadStorageExtension('scan.tiff', 'image/tiff'), '.tiff');
  assert.equal(uploadStorageExtension('photo.avif', 'image/avif'), '.avif');
  assert.equal(uploadStorageExtension('clipboard', 'image/gif'), '.gif');
  assert.equal(uploadStorageExtension('unknown.custom', 'image/x-unknown'), '.bin');
});
