import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeWebSocketFrames, encodeWebSocketBinary, encodeWebSocketText } from './websocket-transport';

function maskedClientText(value: string) {
  const payload = Buffer.from(value);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

test('shared WebSocket transport reassembles masked client frames', () => {
  const frame = maskedClientText('{"type":"input"}');
  const messages: string[] = [];
  const handlers = {
    onClose: () => undefined,
    onPing: () => undefined,
    onText: (payload: string) => messages.push(payload),
  };
  const pending = consumeWebSocketFrames(Buffer.alloc(0), frame.subarray(0, 5), handlers);
  assert.equal(messages.length, 0);
  const remaining = consumeWebSocketFrames(pending, frame.subarray(5), handlers);
  assert.equal(remaining.length, 0);
  assert.deepEqual(messages, ['{"type":"input"}']);
});

test('shared WebSocket transport encodes text and binary opcodes', () => {
  assert.equal(encodeWebSocketText('ok')[0] & 0x0f, 0x1);
  assert.equal(encodeWebSocketBinary(Buffer.from([1, 2]))[0] & 0x0f, 0x2);
});
