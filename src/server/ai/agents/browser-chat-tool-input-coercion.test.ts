import assert from 'node:assert/strict';
import { test } from 'vitest';
import { coerceBrowserChatToolInput, repairBrowserChatToolCallInput } from './browser-chat-tool-input-coercion';

test('deterministically converts supported scalar transport values', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'generate', documentId: 'document-1', program: 'def create_document(job):\n    pass', render: 'false', expectedRevision: '2',
  }), {
    action: 'generate', documentId: 'document-1', program: 'def create_document(job):\n    pass', render: false,
  });
  assert.deepEqual(coerceBrowserChatToolInput('file', { action: 'read', pages: '["1",2]', limit: '40' }), {
    action: 'read', pages: [1, 2], limit: 40,
  });
});

test('normalizes UNO and JavaScript API action casing', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', { action: 'UNOApi' }), { action: 'unoApi' });
  assert.deepEqual(coerceBrowserChatToolInput('file', { action: 'UNO_API' }), { action: 'unoApi' });
  assert.deepEqual(coerceBrowserChatToolInput('file', { action: 'JSAPI' }), { action: 'jsApi' });
  assert.deepEqual(coerceBrowserChatToolInput('file', { action: 'Js-Api' }), { action: 'jsApi' });
});

test('does not reshape model-authored document values', () => {
  const outline = { item: [{ id: 'cover', title: 'Cover' }] };
  const input = { action: 'plan', outline };
  assert.deepEqual(coerceBrowserChatToolInput('file', input), input);
});

test('accepts standard OpenAI-compatible transport envelopes without unwrapping document content', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', '{"arguments":"{\\"action\\":\\"plan\\",\\"documentId\\":\\"solar-system\\",\\"fileName\\":\\"solar-system.pptx\\",\\"documentType\\":\\"pptx\\"}"}'), {
    action: 'plan', documentId: 'solar-system', fileName: 'solar-system.pptx', documentType: 'presentation',
  });
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'plan', params: { documentId: 'solar-system', fileName: 'solar-system.pptx' }, outline: { item: [{ id: 'cover' }] },
  }), {
    action: 'plan', documentId: 'solar-system', fileName: 'solar-system.pptx', documentType: 'presentation', outline: { item: [{ id: 'cover' }] },
  });
});

test('normalizes fileVisual transport envelopes and screenshot id arrays', () => {
  assert.deepEqual(coerceBrowserChatToolInput('fileVisual', {
    params: {
      action: 'READ',
      artifactId: 'chat/generated/deck.pptx',
      screenshotIds: '["screenshot-0001","screenshot-0003"]',
      offset: '2',
      limit: '6',
    },
  }), {
    action: 'read',
    artifactId: 'chat/generated/deck.pptx',
    screenshotIds: ['screenshot-0001', 'screenshot-0003'],
    offset: 2,
    limit: 6,
  });
});

test('drops fields from the retired optimistic revision protocol', () => {
  assert.equal(repairBrowserChatToolCallInput('file', '{"action":"render","expectedRevision":"3"}'), '{"action":"render"}');
  assert.equal(repairBrowserChatToolCallInput('file', '{"action":"plan","outline":{"item":[]}}'), undefined);
});

test('normalizes legacy patch plus replace into Codex change lines without touching indentation', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'edit',
    patch: '*** Begin Patch\n*** Update File: draft.py\n@@\n def create_document(job):\n     title = "Old"\n*** End Patch',
    replace: 'def create_document(job):\n    title = "New"',
  }), {
    action: 'edit',
    patch: '*** Begin Patch\n*** Update File: draft.py\n@@\n-def create_document(job):\n-    title = "Old"\n+def create_document(job):\n+    title = "New"\n*** End Patch',
  });
});

test('drops an accidental replace field when a valid multi-hunk Codex patch is supplied', () => {
  const patch = '*** Begin Patch\n*** Update File: draft.py\n@@\n-old\n+new\n@@\n-left\n+right\n*** End Patch';
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'edit', patch, replace: 'ignored',
  }), { action: 'edit', patch });
});

test('removes accidental outer Markdown or HTML wrappers from browserCode only', () => {
  assert.deepEqual(coerceBrowserChatToolInput('browserCode', {
    reason: '读取标题',
    code: 'nodeRepl.write(await page.title());</code>',
  }), {
    reason: '读取标题',
    code: 'nodeRepl.write(await page.title());',
  });
  assert.deepEqual(coerceBrowserChatToolInput('browserCode', {
    reason: '读取标题',
    code: '```js\nnodeRepl.write(await page.title())\n```',
  }), {
    reason: '读取标题',
    code: 'nodeRepl.write(await page.title())',
  });
  assert.deepEqual(coerceBrowserChatToolInput('browserCode', {
    reason: '读取 HTML',
    code: 'nodeRepl.write("<code>inside</code>")',
  }), {
    reason: '读取 HTML',
    code: 'nodeRepl.write("<code>inside</code>")',
  });
});
