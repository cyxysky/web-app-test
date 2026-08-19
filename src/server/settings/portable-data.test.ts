import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('credentials, Skills, memory, and model configuration round-trip securely', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousMasterKey = process.env.WEBPILOT_CREDENTIAL_MASTER_KEY;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-portable-data-'));
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

  const portableData = await import('./portable-data');
  const credentialVault = await import('../credentials/login-account-vault');
  const personalMemory = await import('../ai/personal-memory');
  const { store } = await import('../db/store');
  const { getSqliteDatabase } = await import('../storage/sqlite-database');
  const sourceUserId = 'source-user';
  const targetUserId = 'target-user';

  try {
    credentialVault.createLoginAccount({
      userId: sourceUserId,
      domain: 'example.com',
      username: 'admin',
      password: 'portable-secret',
      label: '示例账号',
      loginUrl: 'https://example.com/login',
      status: 'active',
    });
    store.upsertSkill({
      userId: sourceUserId,
      title: '打开示例页面',
      description: '在 example.com 中打开指定页面。',
      triggerPhrases: ['打开示例页面'],
      content: { details: '1. 打开导航。\n2. 点击目标入口。' },
      status: 'ready',
    });
    personalMemory.savePersonalMemoryItem({
      userId: sourceUserId,
      scope: 'domain',
      domain: 'example.com',
      type: 'preference',
      key: '默认账号',
      aliases: ['常用账号'],
      value: '优先使用管理员账号',
      confidence: 0.9,
      status: 'active',
    });
    store.saveModelConfig({
      provider: 'openai',
      providers: {
        openai: {
          enabled: true,
          apiKey: 'model-api-secret',
          baseURL: 'https://models.example/v1',
          defaultModel: 'gpt-portable',
          model: 'gpt-portable',
          models: ['gpt-portable', 'gpt-backup'],
        },
      },
    });

    const credentialExport = await portableData.exportPortableData({
      kind: 'credentials',
      userId: sourceUserId,
      passphrase: 'export-password',
    });
    const skillExport = await portableData.exportPortableData({ kind: 'skills', userId: sourceUserId });
    const memoryExport = await portableData.exportPortableData({ kind: 'memory', userId: sourceUserId });
    const modelExport = await portableData.exportPortableData({
      kind: 'model',
      passphrase: 'model-export-password',
    });

    const serializedCredentials = JSON.stringify(credentialExport.bundle);
    assert.doesNotMatch(serializedCredentials, /portable-secret|admin|example\.com/);
    assert.doesNotMatch(JSON.stringify(modelExport.bundle), /model-api-secret|gpt-portable|models\.example/);
    await assert.rejects(() => portableData.importPortableData({
      kind: 'credentials',
      userId: targetUserId,
      passphrase: 'wrong-password',
      bundle: credentialExport.bundle,
    }), /密码错误|文件已损坏/);
    await assert.rejects(() => portableData.importPortableData({
      kind: 'model',
      passphrase: 'wrong-password',
      bundle: modelExport.bundle,
    }), /密码错误|文件已损坏/);

    assert.deepEqual(await portableData.importPortableData({
      kind: 'credentials',
      userId: targetUserId,
      passphrase: 'export-password',
      bundle: credentialExport.bundle,
    }), { kind: 'credentials', created: 1, updated: 0, total: 1 });
    assert.deepEqual(await portableData.importPortableData({
      kind: 'skills',
      userId: targetUserId,
      bundle: skillExport.bundle,
    }), { kind: 'skills', created: 1, updated: 0, total: 1 });
    assert.deepEqual(await portableData.importPortableData({
      kind: 'memory',
      userId: targetUserId,
      bundle: memoryExport.bundle,
    }), { kind: 'memory', created: 1, updated: 0, total: 1 });

    store.saveModelConfig({
      provider: 'deepseek',
      providers: {
        openai: {
          apiKey: '',
          baseURL: 'https://api.openai.com/v1',
          defaultModel: 'gpt-other',
          model: 'gpt-other',
          models: ['gpt-other'],
        },
        deepseek: {
          apiKey: 'temporary-key',
          baseURL: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          model: 'deepseek-chat',
          models: ['deepseek-chat'],
        },
      },
    });
    assert.deepEqual(await portableData.importPortableData({
      kind: 'model',
      passphrase: 'model-export-password',
      bundle: modelExport.bundle,
    }), { kind: 'model', created: 0, updated: 1, total: 1 });

    const importedAccount = credentialVault.listLoginAccounts({ userId: targetUserId })[0];
    assert.equal(importedAccount.domain, 'example.com');
    assert.equal(credentialVault.resolveLoginAccountCredentialById(importedAccount.id, targetUserId)?.password, 'portable-secret');
    assert.equal(store.listSkills(undefined, targetUserId)[0]?.content.details, '1. 打开导航。\n2. 点击目标入口。');
    assert.equal(personalMemory.listPersonalMemoryItems({ userId: targetUserId })[0]?.value, '优先使用管理员账号');
    assert.equal(store.getModelConfig()?.provider, 'openai');
    assert.equal(store.getModelConfig()?.providers.openai?.apiKey, 'model-api-secret');
    assert.equal(store.getModelConfig()?.providers.openai?.enabled, true);
    assert.equal(store.getModelConfig()?.providers.openai?.models?.includes('gpt-portable'), true);
    assert.equal(store.getModelConfig()?.providers.openai?.models?.includes('gpt-backup'), true);

    const secondImport = await portableData.importPortableData({
      kind: 'credentials',
      userId: targetUserId,
      passphrase: 'export-password',
      bundle: credentialExport.bundle,
    });
    assert.deepEqual(secondImport, { kind: 'credentials', created: 0, updated: 1, total: 1 });
  } finally {
    getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousMasterKey === undefined) delete process.env.WEBPILOT_CREDENTIAL_MASTER_KEY;
    else process.env.WEBPILOT_CREDENTIAL_MASTER_KEY = previousMasterKey;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
