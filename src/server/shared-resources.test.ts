import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('shared Skills, memories, and accounts are usable across IDs but writable only by their creator', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousMasterKey = process.env.WEBPILOT_CREDENTIAL_MASTER_KEY;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-shared-resources-'));
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 11).toString('base64');

  const { store } = await import('./db/store');
  const memory = await import('./ai/personal-memory');
  const accounts = await import('./credentials/login-account-vault');
  const portable = await import('./settings/portable-data');
  const database = await import('./storage/sqlite-database');
  const ownerId = 'owner-7';
  const viewerId = 'viewer-9';

  try {
    const sharedSkill = store.upsertSkill({
      userId: ownerId,
      shared: true,
      title: 'Shared navigation',
      description: 'Reusable navigation steps',
      domains: ['example.com'],
      triggerPhrases: ['open shared navigation'],
      content: { details: 'Open the navigation and verify the destination.' },
      status: 'ready',
    });
    store.upsertSkill({
      userId: ownerId,
      title: 'Private navigation',
      description: 'Owner only',
      domains: ['example.com'],
      triggerPhrases: ['private navigation'],
      content: { details: 'Private steps.' },
      status: 'ready',
    });
    assert.deepEqual(store.listSkills(undefined, viewerId).map((skill) => skill.id), [sharedSkill.id]);
    assert.throws(() => store.upsertSkill({
      id: sharedSkill.id,
      userId: viewerId,
      title: 'Hijacked',
      description: 'Must fail',
      content: { details: 'Must fail.' },
    }), /Only the Skill creator/);
    assert.equal(store.deleteSkill(sharedSkill.id, viewerId), false);

    const sharedMemory = memory.savePersonalMemoryItem({
      userId: ownerId,
      shared: true,
      scope: 'domain',
      domain: 'example.com',
      type: 'workflow',
      key: 'shared workflow',
      value: 'Use the shared flow',
      status: 'active',
    });
    memory.savePersonalMemoryItem({
      userId: ownerId,
      scope: 'domain',
      domain: 'example.com',
      type: 'workflow',
      key: 'private workflow',
      value: 'Owner only',
      status: 'active',
    });
    assert.deepEqual(memory.listPersonalMemoryItems({ userId: viewerId }).map((item) => item.id), [sharedMemory.id]);
    assert.equal(memory.searchPersonalMemory({ userId: viewerId, domain: 'example.com', query: 'shared workflow' })[0]?.item.id, sharedMemory.id);
    assert.equal(memory.updatePersonalMemoryItem(sharedMemory.id, { value: 'Hijacked' }, viewerId), undefined);
    assert.equal(memory.deletePersonalMemoryItem(sharedMemory.id, viewerId), undefined);

    const sharedAccount = accounts.createLoginAccount({
      userId: ownerId,
      shared: true,
      domain: 'example.com',
      username: 'shared-admin',
      password: 'shared-secret',
      status: 'active',
    });
    const privateAccount = accounts.createLoginAccount({
      userId: ownerId,
      domain: 'example.com',
      username: 'private-admin',
      password: 'private-secret',
      status: 'active',
    });
    assert.deepEqual(accounts.listLoginAccounts({ userId: viewerId }).map((account) => account.id), [sharedAccount.id]);
    assert.equal(accounts.resolveLoginAccountCredentialById(sharedAccount.id, viewerId)?.password, 'shared-secret');
    assert.equal(accounts.resolveLoginAccountCredentialById(privateAccount.id, viewerId), undefined);
    assert.equal(accounts.updateLoginAccount(sharedAccount.id, { label: 'Hijacked' }, viewerId), undefined);
    assert.equal(accounts.deleteLoginAccount(sharedAccount.id, viewerId), false);

    assert.equal(portable.exportPortableData({ kind: 'skills', userId: viewerId }).count, 0);
    assert.equal(portable.exportPortableData({ kind: 'memory', userId: viewerId }).count, 0);
    assert.equal(portable.exportPortableData({ kind: 'credentials', userId: viewerId, passphrase: 'viewer-export' }).count, 0);

    assert.equal(store.deleteSkill(sharedSkill.id, ownerId), true);
    assert.ok(memory.updatePersonalMemoryItem(sharedMemory.id, { shared: false }, ownerId));
    assert.equal(memory.listPersonalMemoryItems({ userId: viewerId }).length, 0);
    assert.ok(accounts.updateLoginAccount(sharedAccount.id, { shared: false }, ownerId));
    assert.equal(accounts.listLoginAccounts({ userId: viewerId }).length, 0);
  } finally {
    database.getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousMasterKey === undefined) delete process.env.WEBPILOT_CREDENTIAL_MASTER_KEY;
    else process.env.WEBPILOT_CREDENTIAL_MASTER_KEY = previousMasterKey;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
