import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('personal memory tools keep SQLite storage and enforce user-authored write evidence', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-memory-tools-'));
  process.env.APP_DATA_DIR = dataRoot;
  const databaseModule = await import('../storage/sqlite-database');

  try {
    const { createPersonalMemoryTools } = await import('./personal-memory-tools');
    const execute = async (tools: ReturnType<typeof createPersonalMemoryTools>, name: string, input: unknown) => {
      const definition = tools[name] as { execute?: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown> } | undefined;
      assert.ok(definition?.execute, `${name} must be executable`);
      return definition.execute(input, { toolCallId: `call-${name}`, messages: [] });
    };

    const saveTools = createPersonalMemoryTools({
      userId: 'memory-tool-user',
      currentUrl: 'https://example.com/settings',
      sourceSessionId: 'session-1',
      sourceMessageIds: ['message-1'],
      userMessages: ['From now on, always use DOM inspection before screenshots.'],
    });
    const saved = await execute(saveTools, 'memory', {
      action: 'save',
      scope: 'global',
      type: 'preference',
      key: 'browser inspection method',
      aliases: ['DOM first'],
      value: 'Use DOM inspection before screenshots.',
      confidence: 0.95,
      evidence: ['From now on, always use DOM inspection before screenshots.'],
      durability: 'explicit_preference',
    }) as { item: { id: string } };
    assert.match(saved.item.id, /^mem_/);

    let currentUrl = 'https://example.com/dashboard';
    const usedMemoryIds = new Set<string>();
    const searchTools = createPersonalMemoryTools({
      userId: 'memory-tool-user',
      getCurrentUrl: () => currentUrl,
      readOnly: true,
      usedMemoryIds,
    });
    const searched = await execute(searchTools, 'memory', {
      action: 'search',
      query: 'DOM first browser inspection method',
    }) as { items: Array<{ id: string; value: string }> };
    assert.equal(searched.items[0]?.id, saved.item.id);
    assert.equal(searched.items[0]?.value, 'Use DOM inspection before screenshots.');
    await execute(searchTools, 'memory', {
      action: 'search',
      query: 'DOM first browser inspection method',
    });
    const memoryModule = await import('./personal-memory');
    assert.equal(memoryModule.getPersonalMemoryItem(saved.item.id, 'memory-tool-user')?.useCount, 1);

    const dompMemory = memoryModule.savePersonalMemoryItem({
      userId: 'memory-tool-user',
      scope: 'domain',
      domain: 'domp.example.com',
      type: 'workflow',
      key: 'active project system',
      value: 'Use DOMP project workflow.',
    });
    const wikiMemory = memoryModule.savePersonalMemoryItem({
      userId: 'memory-tool-user',
      scope: 'domain',
      domain: 'wiki.example.com',
      type: 'workflow',
      key: 'active project system',
      value: 'Use Wiki documentation workflow.',
    });
    currentUrl = 'https://domp.example.com/project';
    const dompSearch = await execute(searchTools, 'memory', { action: 'search', query: 'active project system' }) as { items: Array<{ id: string }> };
    assert.equal(dompSearch.items.some((item) => item.id === dompMemory.id), true);
    assert.equal(dompSearch.items.some((item) => item.id === wikiMemory.id), false);
    currentUrl = 'https://wiki.example.com/page';
    const wikiSearch = await execute(searchTools, 'memory', { action: 'search', query: 'active project system' }) as { items: Array<{ id: string }> };
    assert.equal(wikiSearch.items.some((item) => item.id === wikiMemory.id), true);
    assert.equal(wikiSearch.items.some((item) => item.id === dompMemory.id), false);

    const invalidWrite = createPersonalMemoryTools({
      userId: 'memory-tool-user',
      currentUrl: 'https://example.com',
      userMessages: ['Please inspect this page once.'],
    });
    await assert.rejects(() => execute(invalidWrite, 'memory', {
      action: 'save',
      scope: 'global',
      type: 'preference',
      key: 'invented preference',
      value: 'Always use screenshots.',
      evidence: ['The assistant inferred this preference.'],
      durability: 'explicit_preference',
    }), /exact quote from a user message/);

    const updateTools = createPersonalMemoryTools({
      userId: 'memory-tool-user',
      currentUrl: 'https://example.com',
      userMessages: ['Update the memory: change the browser inspection method to accessibility tree first.'],
    });
    const updated = await execute(updateTools, 'memory', {
      action: 'update',
      id: saved.item.id,
      value: 'Use the accessibility tree before screenshots.',
      evidence: ['Update the memory: change the browser inspection method to accessibility tree first.'],
    }) as { item: { value: string } };
    assert.equal(updated.item.value, 'Use the accessibility tree before screenshots.');

    const disableTools = createPersonalMemoryTools({
      userId: 'memory-tool-user',
      currentUrl: 'https://example.com',
      userMessages: ['Forget this browser inspection preference.'],
    });
    const disabled = await execute(disableTools, 'memory', {
      action: 'disable',
      id: saved.item.id,
      evidence: ['Forget this browser inspection preference.'],
    }) as { item: { status: string } };
    assert.equal(disabled.item.status, 'disabled');
  } finally {
    databaseModule.closeSqliteDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
