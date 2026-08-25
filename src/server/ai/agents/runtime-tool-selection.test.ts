import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserToolBlockedBeforeBrowserState,
  requiresBrowserStatePreflight,
  runtimeAllowedToolTypes,
  runtimeBrowserSessionToolNames,
  runtimeToolRequiresBrowserSession,
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
  assert.equal(browserToolBlockedBeforeBrowserState('readBrowserState', true, runtimeBrowserSessionToolNames), false);
  assert.equal(browserToolBlockedBeforeBrowserState('browserCode', true, runtimeBrowserSessionToolNames), true);
  assert.equal(browserToolBlockedBeforeBrowserState('waitForHumanVerification', true, runtimeBrowserSessionToolNames), true);
  assert.equal(browserToolBlockedBeforeBrowserState('subagent', true, runtimeBrowserSessionToolNames), false);
  assert.equal(browserToolBlockedBeforeBrowserState('file', true, runtimeBrowserSessionToolNames), false);
  assert.equal(browserToolBlockedBeforeBrowserState('browserCode', false, runtimeBrowserSessionToolNames), false);
});

test('direct main-browser tools use the generic session-start hook', () => {
  assert.equal(runtimeToolRequiresBrowserSession('readBrowserState'), true);
  assert.equal(runtimeToolRequiresBrowserSession('browserCode'), true);
  assert.equal(runtimeToolRequiresBrowserSession('waitForHumanVerification'), true);
  assert.equal(runtimeToolRequiresBrowserSession('subagent'), false);
  assert.equal(runtimeToolRequiresBrowserSession('file'), false);
});

test('subagent calls end the current runtime tool loop before another child result is selected', () => {
  assert.deepEqual(runtimeToolLoopStopToolNames, [
    'waitForHumanVerification',
    'subagent',
  ]);
});
