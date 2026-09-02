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

test('normalizes unified file visual transport envelopes and screenshot id arrays', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    params: {
      action: 'VISUAL_READ',
      artifactId: 'chat/generated/deck.pptx',
      screenshotIds: '["screenshot-0001","screenshot-0003"]',
      offset: '2',
      limit: '6',
    },
  }), {
    action: 'visualRead',
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

test('normalizes deletion-only pseudo-patch plus replace instead of discarding the replacement', () => {
  assert.deepEqual(coerceBrowserChatToolInput('file', {
    action: 'edit',
    patch: '*** Begin Patch\n*** Update File: draft.py\n@@\n-    title = "Old"\n*** End Patch',
    replace: '    title = "New"',
  }), {
    action: 'edit',
    patch: '*** Begin Patch\n*** Update File: draft.py\n@@\n-    title = "Old"\n+    title = "New"\n*** End Patch',
  });
});

test('normalizes repeated Codex patch envelopes into one multi-update envelope', () => {
  const coerced = coerceBrowserChatToolInput('file', {
    action: 'edit',
    documentId: 'deck',
    patch: [
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@',
      '-first',
      '+FIRST',
      '*** End Patch',
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@',
      '-second',
      '+SECOND',
      '*** End Patch',
      '*** End Patch',
    ].join('\n'),
  }) as { patch: string };

  assert.equal((coerced.patch.match(/\*\*\* Begin Patch/g) || []).length, 1);
  assert.equal((coerced.patch.match(/\*\*\* End Patch/g) || []).length, 1);
  assert.equal((coerced.patch.match(/\*\*\* Update File: draft\.py/g) || []).length, 2);
  assert.match(coerced.patch, /-first\n\+FIRST/);
  assert.match(coerced.patch, /-second\n\+SECOND/);
});

test('removes accidental outer Markdown or HTML wrappers from browser action=code only', () => {
  assert.deepEqual(coerceBrowserChatToolInput('browser', {
    action: 'code',
    reason: '读取标题',
    code: 'nodeRepl.write(await page.title());</code>',
  }), {
    action: 'code',
    reason: '读取标题',
    code: 'nodeRepl.write(await page.title());',
  });
  assert.deepEqual(coerceBrowserChatToolInput('browser', {
    action: 'code',
    reason: '读取标题',
    code: '```js\nnodeRepl.write(await page.title())\n```',
  }), {
    action: 'code',
    reason: '读取标题',
    code: 'nodeRepl.write(await page.title())',
  });
  assert.deepEqual(coerceBrowserChatToolInput('browser', {
    action: 'code',
    reason: '读取 HTML',
    code: 'nodeRepl.write("<code>inside</code>")',
  }), {
    action: 'code',
    reason: '读取 HTML',
    code: 'nodeRepl.write("<code>inside</code>")',
  });
});
