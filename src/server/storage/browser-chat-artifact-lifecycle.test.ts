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

test('quota cleanup removes previews and obsolete files before protecting the current draft and delivery', async () => {
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousQuota = process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION;
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-artifact-priority-'));
  process.env.ARTIFACTS_DIR = root;
  process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION = '10';
  const sessionId = 'chat_cccccccccccc';
  const sessionRoot = path.join(root, sessionId);
  const draftRoot = path.join(sessionRoot, 'document-drafts');
  const currentArtifact = path.join(sessionRoot, 'generated', 'deck', 'digest', 'deck.pptx');
  const preview = path.join(sessionRoot, 'attachment-previews', 'cache', 'page.png');
  try {
    await Promise.all([
      mkdir(draftRoot, { recursive: true }),
      mkdir(path.dirname(currentArtifact), { recursive: true }),
      mkdir(path.dirname(preview), { recursive: true }),
    ]);
    await writeFile(path.join(draftRoot, 'deck.py'), Buffer.alloc(8));
    await writeFile(path.join(draftRoot, 'deck.json'), JSON.stringify({
      documentId: 'deck',
      generator: 'uno',
      renderedArtifactId: `${sessionId}/generated/deck/digest/deck.pptx`,
    }));
    await writeFile(currentArtifact, Buffer.alloc(8));
    await writeFile(preview, Buffer.alloc(20));
    const quota = await enforceBrowserChatArtifactQuota(sessionId);
    assert.ok(quota.removedFiles >= 1);
    await assert.rejects(access(preview));
    await access(path.join(draftRoot, 'deck.json'));
    await access(path.join(draftRoot, 'deck.py'));
    await access(currentArtifact);
  } finally {
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    if (previousQuota === undefined) delete process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION;
    else process.env.BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION = previousQuota;
    await rm(root, { force: true, recursive: true });
  }
});
