import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserToolPrerequisiteNames,
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
  assert.equal(requiresBrowserStatePreflight(false, [{
    name: 'browserCode',
    result: {
      ok: true,
      prerequisiteResults: [{
        toolName: 'readBrowserState',
        result: { ok: true, actual: 'live state' },
      }],
    },
  }]), false);
  assert.equal(requiresBrowserStatePreflight(true, []), false);
});

test('browser tools declare bundled prerequisites while live state is pending', () => {
  assert.deepEqual(browserToolPrerequisiteNames('readBrowserState', true, runtimeBrowserSessionToolNames), []);
  assert.deepEqual(browserToolPrerequisiteNames('browserCode', true, runtimeBrowserSessionToolNames), ['readBrowserState']);
  assert.deepEqual(browserToolPrerequisiteNames('waitForHumanVerification', true, runtimeBrowserSessionToolNames), ['readBrowserState']);
  assert.deepEqual(browserToolPrerequisiteNames('subagent', true, runtimeBrowserSessionToolNames), []);
  assert.deepEqual(browserToolPrerequisiteNames('file', true, runtimeBrowserSessionToolNames), []);
  assert.deepEqual(browserToolPrerequisiteNames('browserCode', false, runtimeBrowserSessionToolNames), []);
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
