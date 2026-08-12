import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { readScreenshotForAi } from './browser-chat-image-input';

test('normalizes a TIFF attachment to a model-readable image type', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-image-input-'));
  try {
    const filePath = path.join(directory, 'sample.tiff');
    await writeFile(filePath, await sharp({
      create: { background: '#35a57a', channels: 4, height: 12, width: 12 },
    }).tiff().toBuffer());
    const result = await readScreenshotForAi(filePath);
    assert.equal(result.mediaType, 'image/png');
    assert.equal(result.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
