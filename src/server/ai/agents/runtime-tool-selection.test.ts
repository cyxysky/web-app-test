import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeAllowedToolTypes } from './runtime-tool-selection';

const nativeToolNames = ['getPageState', 'readObservation', 'clickDomNode', 'reportState'];
const observationToolNames = new Set(['readObservation']);

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

test('runtimeAllowedToolTypes hides observation tools from Codex model calls', () => {
  assert.deepEqual(
    runtimeAllowedToolTypes({
      browserChatMode: false,
      codexMode: true,
      nativeToolNames,
      observationToolNames,
    }),
    ['clickDomNode', 'reportState'],
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
    ['clickDomNode', 'answer'],
  );
});
