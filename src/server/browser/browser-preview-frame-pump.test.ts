import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserPreviewFramePump } from './browser-preview-frame-pump';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('preview pump transmits only new frames and coalesces bursts to the newest frame', async () => {
  const sent: number[] = [];
  const pump = new BrowserPreviewFramePump<{ id: number; capturedAt: string }>({
    intervalMs: () => 15,
    onFrame: async (frame) => {
      sent.push(frame.id);
      await wait(2);
    },
  });
  pump.push({ id: 1, capturedAt: 'one' });
  await pump.flushLatest();
  pump.push({ id: 2, capturedAt: 'two' });
  pump.push({ id: 3, capturedAt: 'three' });
  await wait(20);
  await pump.flushLatest();
  const metrics = pump.metrics();
  await pump.stop();
  assert.equal(sent.at(-1), 3);
  assert.equal(sent.includes(2), false);
  assert.equal(metrics.nativeFrames, 3);
  assert.equal(metrics.transmittedFrames, sent.length);
  assert.ok(metrics.coalescedFrames >= 1);
});

test('preview pump never republishes a static frame', async () => {
  let sent = 0;
  const pump = new BrowserPreviewFramePump<{ capturedAt: string }>({
    intervalMs: () => 5,
    onFrame: () => { sent += 1; },
  });
  pump.push({ capturedAt: 'one' });
  await pump.flushLatest();
  await wait(25);
  await pump.stop();
  assert.equal(sent, 1);
});
