import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requiresBrowserStatePreflight,
  runtimeAllowedToolTypes,
  toolsAllowedBeforeBrowserState,
} from './runtime-tool-selection';

const nativeToolNames = ['browserCode', 'reportState'];
const observationToolNames = new Set<string>();

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

test('runtimeAllowedToolTypes keeps browserCode in Codex object mode', () => {
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
    ['browserCode', 'answer'],
  );
});

test('browser state gate remains pending until the browser preflight has been attempted', () => {
  assert.equal(requiresBrowserStatePreflight(false, []), true);
  assert.equal(requiresBrowserStatePreflight(false, [{ name: 'browserCode', result: { ok: true } }]), true);
  assert.equal(requiresBrowserStatePreflight(false, [{ name: 'readBrowserState', result: { ok: false } }]), false);
  assert.equal(requiresBrowserStatePreflight(true, []), false);
});

test('browser state gate keeps direct answers and non-browser tools available', () => {
  assert.deepEqual(
    toolsAllowedBeforeBrowserState(
      ['readBrowserState', 'browserCode', 'readFile', 'answer'],
      new Set(['readBrowserState', 'browserCode']),
    ),
    ['readBrowserState', 'readFile', 'answer'],
  );
});
