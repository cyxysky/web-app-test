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

const nativeToolNames = ['browser', 'file'];
const observationToolNames = new Set<string>();

test('runtimeAllowedToolTypes keeps native tools outside Codex mode', () => {
  assert.deepEqual(runtimeAllowedToolTypes({
    browserChatMode: false,
    codexMode: false,
    nativeToolNames,
    observationToolNames,
  }), nativeToolNames);
});

test('runtimeAllowedToolTypes adds answer in Codex browser chat', () => {
  assert.deepEqual(runtimeAllowedToolTypes({
    browserChatMode: true,
    codexMode: true,
    nativeToolNames,
    observationToolNames,
  }), ['browser', 'file', 'answer']);
});

test('browser state gate remains pending until state has been attempted', () => {
  assert.equal(requiresBrowserStatePreflight(false, []), true);
  assert.equal(requiresBrowserStatePreflight(false, [{ name: 'browser', input: { action: 'code' }, result: { ok: true } }]), true);
  assert.equal(requiresBrowserStatePreflight(false, [{ name: 'browser', input: { action: 'state' }, result: { ok: false } }]), false);
  assert.equal(requiresBrowserStatePreflight(false, [{
    name: 'browser',
    input: { action: 'code' },
    result: {
      ok: true,
      prerequisiteResults: [{ toolName: 'browser.state', result: { ok: true, actual: 'live state' } }],
    },
  }]), false);
  assert.equal(requiresBrowserStatePreflight(true, []), false);
});

test('browser actions declare bundled state prerequisites while state is pending', () => {
  assert.deepEqual(browserToolPrerequisiteNames('browser', { action: 'state' }, true, runtimeBrowserSessionToolNames), []);
  assert.deepEqual(browserToolPrerequisiteNames('browser', { action: 'code' }, true, runtimeBrowserSessionToolNames), ['browser.state']);
  assert.deepEqual(browserToolPrerequisiteNames('browser', { action: 'waitForHumanVerification' }, true, runtimeBrowserSessionToolNames), ['browser.state']);
  assert.deepEqual(browserToolPrerequisiteNames('subagent', {}, true, runtimeBrowserSessionToolNames), []);
  assert.deepEqual(browserToolPrerequisiteNames('file', {}, true, runtimeBrowserSessionToolNames), []);
  assert.deepEqual(browserToolPrerequisiteNames('browser', { action: 'code' }, false, runtimeBrowserSessionToolNames), []);
});

test('the unified browser tool uses the generic session-start hook', () => {
  assert.equal(runtimeToolRequiresBrowserSession('browser'), true);
  assert.equal(runtimeToolRequiresBrowserSession('subagent'), false);
  assert.equal(runtimeToolRequiresBrowserSession('file'), false);
});

test('subagent calls end the current runtime tool loop', () => {
  assert.deepEqual(runtimeToolLoopStopToolNames, ['finalResponse', 'subagent']);
});
