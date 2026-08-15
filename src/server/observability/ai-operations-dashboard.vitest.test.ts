import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import { archiveAiOperationsChatSession } from './ai-operations-chat-archive';
import { readAiOperationsDashboard } from './ai-operations-dashboard';
import { closeSqliteDatabase, getSqliteDatabase } from '@/server/storage/sqlite-database';

describe('AI operations durable chat statistics', () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-ai-operations-'));

  beforeAll(() => {
    closeSqliteDatabase();
    process.env.APP_DATA_DIR = dataRoot;
  });

  afterAll(() => {
    closeSqliteDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  });

  it('preserves task and token metrics after the source conversation is deleted', () => {
    const timestamp = new Date().toISOString();
    const userMessage = {
      content: 'content that must be deleted',
      createdAt: timestamp,
      id: 'message-user',
      role: 'user',
    };
    const assistantMessage = {
      content: 'completed',
      createdAt: timestamp,
      id: 'message-assistant',
      role: 'assistant',
      status: 'complete',
      updatedAt: timestamp,
    };
    const usageLog = {
      details: JSON.stringify({
        value: {
          aiOutput: {
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        },
      }),
      id: 'log-usage',
      message: 'AI response',
      phase: 'ai:runtime:response',
      time: timestamp,
    };
    const snapshot = {
      createdAt: timestamp,
      id: 'chat_durable_metrics_test',
      logs: [usageLog],
      messages: [userMessage, assistantMessage],
      model: 'test-model',
      modelProvider: 'openai',
      steps: [{ index: 0, tools: [{ recovered: true }] }],
      targetUrl: 'https://crm.example.test/accounts',
      updatedAt: timestamp,
      userId: '7',
    } as unknown as BrowserChatSessionSnapshot;
    const database = getSqliteDatabase();
    database.prepare(`
      INSERT INTO browser_chat_session (
        id, user_id, title, status, revision, snapshot_json, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.userId || null,
      'Conversation to delete',
      'idle',
      JSON.stringify(snapshot),
      JSON.stringify({
        model: snapshot.model,
        modelProvider: snapshot.modelProvider,
        targetUrl: snapshot.targetUrl,
        userId: snapshot.userId,
      }),
      timestamp,
      timestamp,
    );
    database.prepare(`
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
    `).run(snapshot.id, userMessage.id, timestamp, JSON.stringify(userMessage));
    database.prepare(`
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
    `).run(snapshot.id, assistantMessage.id, timestamp, JSON.stringify(assistantMessage));
    database.prepare(`
      INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
    `).run(snapshot.id, 0, JSON.stringify(snapshot.steps[0]));
    database.prepare(`
      INSERT INTO browser_chat_log (session_id, id, time, message_id, record_json) VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.id, usageLog.id, timestamp, assistantMessage.id, JSON.stringify(usageLog));

    archiveAiOperationsChatSession(snapshot);
    const beforeDelete = readAiOperationsDashboard(7);
    expect(beforeDelete.overview.chatTasks).toBe(1);
    expect(beforeDelete.overview.passed).toBe(1);
    expect(beforeDelete.overview.repairs).toBe(1);
    expect(beforeDelete.users.find((user) => user.userId === '7')?.totalTokens).toBe(150);

    database.prepare('DELETE FROM browser_chat_session WHERE id = ?').run(snapshot.id);
    expect((database.prepare('SELECT COUNT(*) AS count FROM browser_chat_message WHERE session_id = ?')
      .get(snapshot.id) as { count: number }).count).toBe(0);

    const afterDelete = readAiOperationsDashboard(7);
    expect(afterDelete.overview.chatTasks).toBe(beforeDelete.overview.chatTasks);
    expect(afterDelete.overview.passed).toBe(beforeDelete.overview.passed);
    expect(afterDelete.overview.repairs).toBe(beforeDelete.overview.repairs);
    expect(afterDelete.users.find((user) => user.userId === '7')?.totalTokens).toBe(150);
    expect((database.prepare('SELECT COUNT(*) AS count FROM ai_operations_chat_archive WHERE session_id = ?')
      .get(snapshot.id) as { count: number }).count).toBe(1);
    const archive = database.prepare(`
      SELECT record_json FROM ai_operations_chat_archive WHERE session_id = ?
    `).get(snapshot.id) as { record_json: string };
    expect(archive.record_json).not.toContain('content that must be deleted');
    expect(archive.record_json).not.toContain('/accounts');
  });
});
