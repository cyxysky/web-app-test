import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserToolBlockedBeforeBrowserState,
  requiresBrowserStatePreflight,
  runtimeAllowedToolTypes,
  runtimeToolLoopStopToolNames,
} from './runtime-tool-selection';

const nativeToolNames = ['browserCode', 'file'];
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

test('runtimeAllowedToolTypes adds answer in Codex browser chat', () => {
  assert.deepEqual(
    runtimeAllowedToolTypes({
      browserChatMode: true,
      codexMode: true,
      nativeToolNames,
      observationToolNames,
    }),
    ['browserCode', 'file', 'answer'],
  );
});

test('browser state gate remains pending until the browser preflight has been attempted', () => {
  assert.equal(requiresBrowserStatePreflight(false, []), true);
  assert.equal(requiresBrowserStatePreflight(false, [{ name: 'browserCode', result: { ok: true } }]), true);
  assert.equal(requiresBrowserStatePreflight(false, [{ name: 'readBrowserState', result: { ok: false } }]), false);
  assert.equal(requiresBrowserStatePreflight(true, []), false);
});

test('browser state gate blocks execution without hiding tool schemas', () => {
  const browserTools = new Set(['readBrowserState', 'browserCode', 'subagent']);
  assert.equal(browserToolBlockedBeforeBrowserState('readBrowserState', true, browserTools), false);
  assert.equal(browserToolBlockedBeforeBrowserState('browserCode', true, browserTools), true);
  assert.equal(browserToolBlockedBeforeBrowserState('subagent', true, browserTools), true);
  assert.equal(browserToolBlockedBeforeBrowserState('subagent', true, browserTools, { action: 'read' }), false);
  assert.equal(browserToolBlockedBeforeBrowserState('subagent', true, browserTools, { action: 'spawn' }), true);
  assert.equal(browserToolBlockedBeforeBrowserState('file', true, browserTools), false);
  assert.equal(browserToolBlockedBeforeBrowserState('subagent', false, browserTools), false);
});

test('subagent calls end the current runtime tool loop before another child result is selected', () => {
  assert.deepEqual(runtimeToolLoopStopToolNames, [
    'waitForHumanVerification',
    'subagent',
  ]);
});
