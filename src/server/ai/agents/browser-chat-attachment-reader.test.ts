import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBrowserChatAttachment } from './browser-chat-attachment-reader';
import { BROWSER_CHAT_FILE_READ_MIN_CHARS, normalizeBrowserChatFileReadLimit } from './browser-chat-file-read';

test('readFile defaults to 20000 characters and clamps smaller requested limits', () => {
  assert.equal(normalizeBrowserChatFileReadLimit(undefined), 20_000);
  assert.equal(normalizeBrowserChatFileReadLimit(300), 20_000);
  assert.equal(normalizeBrowserChatFileReadLimit(30_000), 30_000);
});

test('readFile returns at least 20000 characters when a smaller limit is requested', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-read-file-'));
  const filePath = path.join(directory, 'large.md');
  const content = 'x'.repeat(BROWSER_CHAT_FILE_READ_MIN_CHARS + 5_000);
  await writeFile(filePath, content, 'utf8');

  try {
    const result = await readBrowserChatAttachment({
      absolutePath: filePath,
      attachment: {
        id: 'file-1',
        kind: 'file',
        name: 'large.md',
        path: 'uploads/large.md',
        type: 'text/markdown',
        url: '/api/artifacts/uploads/large.md',
      },
      limit: 300,
      offset: 100,
    });

    assert.equal(result.ok, true);
    assert.match(result.actual, /字符区间：100-20100 \/ 25000/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
