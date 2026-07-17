import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeAllowedToolTypes } from './runtime-tool-selection';

const nativeToolNames = ['takeSnapshot', 'mouse', 'keyboard', 'selectOption', 'reportState'];
const observationToolNames = new Set(['takeSnapshot']);

test('runtimeAllowedToolTypes keeps native tools outside Codex mode', () => {
  assert.deepEqual(
    runtimeAllowedToolTypes({
      browserChatMode: false,
      codexMode: false,
      nativeToolNames,
      observationToolNames,
    }),
    nativeToolNames,
  );
});

test('runtimeAllowedToolTypes keeps snapshot and unified input tools in Codex object mode', () => {
  assert.deepEqual(
    runtimeAllowedToolTypes({
      browserChatMode: false,
      codexMode: true,
      nativeToolNames,
      observationToolNames,
    }),
    nativeToolNames,
  );
});

test('runtimeAllowedToolTypes swaps reportState for answer in Codex browser chat', () => {
  assert.deepEqual(
    runtimeAllowedToolTypes({
      browserChatMode: true,
      codexMode: true,
      nativeToolNames,
      observationToolNames,
    }),
    ['takeSnapshot', 'mouse', 'keyboard', 'selectOption', 'answer'],
  );
});
