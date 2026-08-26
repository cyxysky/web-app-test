import assert from 'node:assert/strict';
import test from 'node:test';
import { currentRuntimeTimePromptLine } from './runtime-agent.prompt';

test('runtime system prompt time line contains local time, timezone, and stable ISO time', () => {
  const line = currentRuntimeTimePromptLine(new Date('2026-08-26T06:07:08.000Z'));
  assert.match(line, /^Current time: /);
  assert.match(line, /2026/);
  assert.match(line, /ISO 2026-08-26T06:07:08\.000Z/);
  assert.match(line, /\([^)]+; ISO /);
});
