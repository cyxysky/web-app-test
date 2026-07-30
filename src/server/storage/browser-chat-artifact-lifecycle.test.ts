import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deleteBrowserChatArtifacts, enforceBrowserChatArtifactQuota } from './browser-chat-artifact-lifecycle';

test('session artifact cleanup includes child-Agent directories but not another session', async () => {
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousQuota = process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION;
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-artifacts-'));
  process.env.ARTIFACTS_DIR = root;
  process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION = '5';
  const sessionId = 'chat_aaaaaaaaaaaa';
  const otherId = 'chat_bbbbbbbbbbbb';
  try {
    await mkdir(path.join(root, sessionId), { recursive: true });
    await mkdir(path.join(root, `${sessionId}_child`), { recursive: true });
    await mkdir(path.join(root, otherId), { recursive: true });
    await writeFile(path.join(root, sessionId, 'one.bin'), Buffer.alloc(4));
    await writeFile(path.join(root, `${sessionId}_child`, 'two.bin'), Buffer.alloc(4));
    const quota = await enforceBrowserChatArtifactQuota(sessionId);
    assert.ok(quota.remainingBytes <= 5);
    assert.ok(quota.removedFiles >= 1);
    assert.equal(await deleteBrowserChatArtifacts(sessionId), 2);
    await assert.rejects(access(path.join(root, sessionId)));
    await access(path.join(root, otherId));
  } finally {
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    if (previousQuota === undefined) delete process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION;
    else process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION = previousQuota;
    await rm(root, { force: true, recursive: true });
  }
});
