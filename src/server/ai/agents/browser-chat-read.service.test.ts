import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime state reads require the owning browser chat user and return every variable', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-browser-chat-state-read-'));
  process.env.APP_DATA_DIR = dataRoot;
  const databaseModule = await import('@/server/storage/sqlite-database');
  const recordStore = await import('@/server/storage/sqlite-record-store');
  const stateStore = await import('@/server/storage/browser-code-runtime-state');
  const readServiceSpecifier: string = './browser-chat-read.service.ts';
  const readService = await import(readServiceSpecifier) as typeof import('./browser-chat-read.service');

  try {
    const timestamp = new Date().toISOString();
    recordStore.writeBrowserChatSessionRecord({
      id: 'state-owner-session',
      userId: 'state-owner',
      title: 'State owner session',
      status: 'closed',
      createdAt: timestamp,
      updatedAt: timestamp,
    }, {}, [], [], []);
    stateStore.executeBrowserCodeRuntimeStateOperation('state-owner-session', {
      action: 'set',
      input: { key: 'office.stage', value: 'verified' },
    });
    stateStore.executeBrowserCodeRuntimeStateOperation('state-owner-session', {
      action: 'set',
      input: { key: 'office.files', value: ['deck.pptx', 'report.docx', 'data.xlsx'] },
    });

    const owned = readService.readBrowserChatRuntimeState('state-owner-session', 'state-owner');
    assert.equal(owned?.count, 2);
    assert.deepEqual(owned?.items.map((item) => item.key), ['office.files', 'office.stage']);
    assert.equal(readService.readBrowserChatRuntimeState('state-owner-session', 'another-user'), undefined);
    assert.equal(readService.readBrowserChatRuntimeState('missing-session', 'state-owner'), undefined);
  } finally {
    databaseModule.closeSqliteDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
