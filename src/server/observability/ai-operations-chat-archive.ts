import type { BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import { executeDatabase, queryDatabase } from '@/server/db/database';

type JsonRecord = Record<string, unknown>;

export type ArchivedAiOperationsChatMessage = {
  durationMs: number;
  id: string;
  role: 'assistant' | 'user';
  status: string;
  time: string;
};

export type ArchivedAiOperationsChatUsage = {
  inputTokens: number;
  outputTokens: number;
  time: string;
  totalTokens: number;
};

export type ArchivedAiOperationsChatSession = {
  archivedAt: string;
  messages: ArchivedAiOperationsChatMessage[];
  model: string;
  provider: string;
  repairs: number;
  sessionId: string;
  targetUrl: string;
  updatedAt: string;
  usages: ArchivedAiOperationsChatUsage[];
  userId: string;
};

type ArchiveRow = {
  record_json: string;
};

function recordValue(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function textValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function numberValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function tokenValue(value: unknown) {
  const record = recordValue(value);
  return numberValue(record.total ?? record.totalTokens ?? value);
}

function timestampMs(value: unknown) {
  const timestamp = Date.parse(textValue(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function targetIdentity(value: unknown) {
  const raw = textValue(value);
  if (!raw) return '';
  try {
    return new URL(raw).hostname;
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0];
  }
}

function normalizedStatus(value: unknown) {
  const status = textValue(value).toLowerCase();
  if (['passed', 'complete', 'completed', 'success', 'succeeded'].includes(status)) return 'passed';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (['blocked', 'skipped'].includes(status)) return 'blocked';
  if (['running', 'queued', 'pending'].includes(status)) return 'running';
  if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
  return 'unknown';
}

function usageFromLog(value: unknown): ArchivedAiOperationsChatUsage | undefined {
  const log = recordValue(value);
  if (!['ai:runtime:object', 'ai:runtime:response'].includes(textValue(log.phase))) return undefined;
  const details = recordValue(log.details);
  const payload = recordValue(details.value);
  const aiOutput = recordValue(payload.aiOutput ?? details.aiOutput);
  const response = recordValue(aiOutput.response);
  const usage = recordValue(aiOutput.usage ?? response.usage);
  const inputTokens = tokenValue(usage.inputTokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = tokenValue(usage.outputTokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    tokenValue(usage.totalTokens ?? usage.total_tokens),
  );
  const time = textValue(log.time);
  return totalTokens && time ? { inputTokens, outputTokens, time, totalTokens } : undefined;
}

export async function archiveAiOperationsChatSession(session: BrowserChatSessionSnapshot) {
  const archivedAt = new Date().toISOString();
  const messages = session.messages.flatMap<ArchivedAiOperationsChatMessage>((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const time = message.updatedAt || message.createdAt;
    if (!time) return [];
    const startedAt = timestampMs(message.createdAt);
    const finishedAt = timestampMs(message.updatedAt || time);
    return [{
      durationMs: startedAt && finishedAt >= startedAt ? finishedAt - startedAt : 0,
      id: message.id,
      role: message.role,
      status: message.role === 'assistant'
        ? normalizedStatus(message.status || (message.content ? 'passed' : 'unknown'))
        : 'unknown',
      time,
    }];
  });
  const usages = session.logs
    .map((log) => usageFromLog(log))
    .filter((usage): usage is ArchivedAiOperationsChatUsage => Boolean(usage));
  const repairs = session.steps.reduce((count, step) => (
    count + (step.tools || []).filter((tool) => tool.recovered === true).length
  ), 0);
  const eventTimes = [
    ...messages.map((message) => message.time),
    ...usages.map((usage) => usage.time),
  ].filter(Boolean).sort();
  const record: ArchivedAiOperationsChatSession = {
    archivedAt,
    messages,
    model: String(session.model || '').trim() || 'unknown-model',
    provider: String(session.modelProvider || '').trim() || 'unknown-provider',
    repairs,
    sessionId: session.id,
    targetUrl: targetIdentity(session.targetUrl),
    updatedAt: session.updatedAt,
    usages,
    userId: String(session.userId || '').trim() || 'unknown',
  };
  await executeDatabase(`
    INSERT INTO ai_operations_chat_archive (
      session_id, user_id, record_json, first_event_at, last_event_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      user_id = excluded.user_id,
      record_json = excluded.record_json,
      first_event_at = excluded.first_event_at,
      last_event_at = excluded.last_event_at,
      archived_at = excluded.archived_at
  `, [
    record.sessionId,
    record.userId,
    JSON.stringify(record),
    eventTimes[0] || session.createdAt || archivedAt,
    eventTimes[eventTimes.length - 1] || session.updatedAt || archivedAt,
    archivedAt,
  ]);
}

export async function readArchivedAiOperationsChatSessions() {
  const rows = await queryDatabase<ArchiveRow>(`
    SELECT record_json FROM ai_operations_chat_archive
    ORDER BY last_event_at DESC
  `);
  return rows.flatMap<ArchivedAiOperationsChatSession>((row) => {
    try {
      const parsed = JSON.parse(row.record_json) as ArchivedAiOperationsChatSession;
      return parsed?.sessionId && Array.isArray(parsed.messages) && Array.isArray(parsed.usages) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
