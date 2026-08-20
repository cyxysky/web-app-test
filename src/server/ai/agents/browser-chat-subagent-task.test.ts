import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserChatSubagentTasks } from './browser-chat-subagent-task';

test('child Agent spawn input keeps the explicit title, URL, and instruction', () => {
  assert.deepEqual(normalizeBrowserChatSubagentTasks([{
    title: 'Read basic-level-accessor source',
    instruction: 'Read and return basic-level-accessor.ts source without analysis.',
    url: 'https://example.com/basic-level-accessor.ts',
  }]), [{
    title: 'Read basic-level-accessor source',
    instruction: 'Read and return basic-level-accessor.ts source without analysis.',
    url: 'https://example.com/basic-level-accessor.ts',
  }]);
});

test('a single flat child Agent task is accepted without an array wrapper', () => {
  assert.deepEqual(normalizeBrowserChatSubagentTasks({
    title: 'Read package metadata',
    instruction: 'Return the package metadata and source URL.',
    url: 'https://example.com/package',
  }), [{
    title: 'Read package metadata',
    instruction: 'Return the package metadata and source URL.',
    url: 'https://example.com/package',
  }]);
});

test('child Agent spawn input has no fixed batch-size ceiling', () => {
  const tasks = normalizeBrowserChatSubagentTasks(Array.from({ length: 25 }, (_, index) => ({
    title: `Read page ${index + 1}`,
    instruction: `Read page ${index + 1}`,
    url: `https://example.com/${index + 1}`,
  })));
  assert.equal(tasks.length, 25);
});

test('all three simple task fields are required and malformed values are rejected', () => {
  assert.deepEqual(normalizeBrowserChatSubagentTasks([{ title: 'Old title', url: 'https://example.com' }]), []);
  assert.deepEqual(normalizeBrowserChatSubagentTasks(['Read page']), []);
  assert.deepEqual(normalizeBrowserChatSubagentTasks([{ instruction: 'Read page' }]), []);
  assert.deepEqual(normalizeBrowserChatSubagentTasks([{ title: 'Read page', instruction: 'Read page', url: 'not-a-url' }]), []);
});
