import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { inspectRenderedPage, validateOfficeArtifact } from './office-artifact-validator';

test('validates the final OOXML package independently from its authoring engine', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-validator-'));
  const target = path.join(directory, 'sample.pptx');
  try {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"/>');
    zip.file('ppt/slides/slide1.xml', '<a:rPr typeface="Arial" xmlns:a="a"/>');
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({ absolutePath: target, extension: '.pptx' });
    assert.equal(result.passed, true);
    assert.deepEqual(result.requestedFonts, ['Arial']);
    assert.ok(Array.isArray(result.media));
    assert.ok(result.platform.length > 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('flags a nearly uniform rendered page for automatic visual review', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-page-validator-'));
  const target = path.join(directory, 'blank.png');
  try {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } }).png().toFile(target);
    const result = await inspectRenderedPage(target);
    assert.ok(result.issues.some((issue) => issue.code === 'PAGE_APPEARS_BLANK'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
