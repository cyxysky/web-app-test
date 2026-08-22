import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  coerceBrowserChatToolInput,
  repairBrowserChatToolCallInput,
} from './browser-chat-tool-input-coercion';

test('repairs JSON container strings and scalar strings for file generation', () => {
  const raw = JSON.stringify({
    action: 'generate',
    documentId: 'document-1',
    blocks: '[{"id":"page-1","type":"page","children":[{"id":"title","type":"text","style":{"x":"12","opacity":"0.8"},"text":"Hello"}]}]',
    render: 'false',
  });
  const repaired = repairBrowserChatToolCallInput('file', raw);
  assert.ok(repaired);
  assert.deepEqual(JSON.parse(repaired), {
    action: 'generate',
    documentId: 'document-1',
    blocks: [{
      id: 'page-1',
      type: 'page',
      children: [{ id: 'title', type: 'text', style: { x: 12, opacity: 0.8 }, text: 'Hello' }],
    }],
    render: false,
  });
});

test('repairs document page booleans and numbers without changing semantic strings', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'plan',
    document: '{"page":{"width":"1280","height":"720","showPageNumber":"true","header":"2026"}}',
    outline: '[{"id":"cover","title":"封面","suggestedBlocks":"[\\"text\\",\\"shape\\"]"}]',
  }), {
    action: 'plan',
    document: { page: { width: 1280, height: 720, showPageNumber: true, header: '2026' } },
    outline: [{ id: 'cover', title: '封面', suggestedBlocks: ['text', 'shape'] }],
  });
});

test('wraps schema-shaped singleton outline, block, and edit operation objects', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'plan',
    outline: { id: 'cover', title: '封面', suggestedBlocks: '["text","shape"]' },
  }), {
    action: 'plan',
    outline: [{ id: 'cover', title: '封面', suggestedBlocks: ['text', 'shape'] }],
  });
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'generate',
    blocks: {
      id: 'page-1',
      type: 'page',
      children: { id: 'title', type: 'text', text: 'Hello' },
    },
    render: 'true',
  }), {
    action: 'generate',
    blocks: [{
      id: 'page-1',
      type: 'page',
      children: [{ id: 'title', type: 'text', text: 'Hello' }],
    }],
    render: true,
  });
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'edit',
    operations: { op: 'remove', blockId: 'title' },
  }), {
    action: 'edit',
    operations: [{ op: 'remove', blockId: 'title' }],
  });
});

test('does not specially unwrap item containers', () => {
  const uniqueItemContainer = {
    item: { id: 'title', type: 'text', text: 'Hello' },
  };
  const blocks = {
    item: { id: 'title', type: 'text', text: 'Hello' },
    text: 'ambiguous sibling',
  };
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'generate',
    blocks: uniqueItemContainer,
  }), {
    action: 'generate',
    blocks: uniqueItemContainer,
  });
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'generate',
    blocks,
  }), {
    action: 'generate',
    blocks,
  });
});

test('does not infer a missing block array from flattened top-level fields', () => {
  const input = { action: 'generate', blocks: '', id: 'title', type: 'text', render: 'true' };
  assert.deepEqual(coerceBrowserChatToolInput('file', input), {
    ...input,
    render: true,
  });
});

test('does not coerce inputs for unrelated tools', () => {
  const input = { render: 'true', limit: '20' };
  assert.equal(coerceBrowserChatToolInput('browserCode', input), input);
});
