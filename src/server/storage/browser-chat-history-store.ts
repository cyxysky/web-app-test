import { getSqliteDatabase, runSqliteTransaction } from './sqlite-database';

export type BrowserChatHistoryKind = 'logs' | 'messages' | 'steps';

export type BrowserChatHistoryPageState = {
  cursor?: string;
  hasMore: boolean;
};

export type BrowserChatHistoryState = {
  logs: BrowserChatHistoryPageState;
  messages: BrowserChatHistoryPageState;
  steps: BrowserChatHistoryPageState;
};

export type BrowserChatHistoryPage<T> = BrowserChatHistoryPageState & {
  items: T[];
};

export const BROWSER_CHAT_MESSAGE_PAGE_SIZE = 10;

type HistoryCursor = {
  id?: string;
  kind: BrowserChatHistoryKind;
  value: number | string;
};

type JsonHistoryRow = {
  id: string;
  record_json: string;
  sort_value: number | string;
};

function parseJson<T>(value: string) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

type ExpirableBrowserChatRecord = Record<string, unknown> & {
  activity?: unknown;
  busy?: boolean;
  content?: string;
  createdAt?: string;
  id?: string;
  messageId?: string;
  role?: string;
  status?: string;
  stepIndexes?: number[];
  updatedAt?: string;
};

export function expireBrowserChatSessionTurnIfNeeded(sessionId: string, maxAgeMs: number) {
  const timeoutMs = Math.max(60_000, Math.floor(Number(maxAgeMs) || 20 * 60_000));
  return runSqliteTransaction((database) => {
    const sessionRow = database.prepare(`
      SELECT status, snapshot_json, summary_json
      FROM browser_chat_session
      WHERE id = ?
    `).get(sessionId) as {
      status?: string;
      snapshot_json?: string;
      summary_json?: string;
    } | undefined;
    if (!sessionRow?.snapshot_json) return false;
    const snapshot = parseJson<ExpirableBrowserChatRecord>(sessionRow.snapshot_json);
    if (!snapshot || (sessionRow.status !== 'running' && snapshot.status !== 'running' && snapshot.busy !== true)) return false;

    const messageRow = database.prepare(`
      SELECT id, record_json
      FROM browser_chat_message
      WHERE session_id = ?
        AND json_extract(record_json, '$.role') = 'assistant'
        AND json_extract(record_json, '$.status') = 'running'
      ORDER BY time DESC, id DESC
      LIMIT 1
    `).get(sessionId) as { id?: string; record_json?: string } | undefined;
    const message = messageRow?.record_json
      ? parseJson<ExpirableBrowserChatRecord>(messageRow.record_json)
      : undefined;
    const startedAt = Date.parse(String(message?.createdAt || ''));
    if (!messageRow?.id || !message || !Number.isFinite(startedAt) || Date.now() - startedAt < timeoutMs) return false;

    const timestamp = new Date().toISOString();
    const minutes = Math.round(timeoutMs / 60_000);
    const timeoutMessage = `This browser chat turn exceeded the ${minutes} minute hard limit and was stopped.`;
    const terminalMessage: ExpirableBrowserChatRecord = {
      ...message,
      content: String(message.content || '').trim() || timeoutMessage,
      status: 'failed',
      activity: undefined,
      updatedAt: timestamp,
    };
    database.prepare(`
      UPDATE browser_chat_message
      SET time = ?, record_json = ?
      WHERE session_id = ? AND id = ?
    `).run(timestamp, JSON.stringify(terminalMessage), sessionId, messageRow.id);

    const stepIndexes = new Set(Array.isArray(message.stepIndexes) ? message.stepIndexes : []);
    const stepRows = database.prepare(`
      SELECT step_index, record_json
      FROM browser_chat_step
      WHERE session_id = ?
    `).all(sessionId) as Array<{ step_index: number; record_json: string }>;
    const updateStep = database.prepare(`
      UPDATE browser_chat_step SET record_json = ?
      WHERE session_id = ? AND step_index = ?
    `);
    for (const row of stepRows) {
      const step = parseJson<ExpirableBrowserChatRecord>(row.record_json);
      if (!step || step.status !== 'running') continue;
      if (step.messageId !== messageRow.id && !stepIndexes.has(row.step_index)) continue;
      updateStep.run(JSON.stringify({
        ...step,
        status: 'failed',
        actual: String(step.actual || '').trim() || timeoutMessage,
      }), sessionId, row.step_index);
    }

    const terminalSession: ExpirableBrowserChatRecord = {
      ...snapshot,
      activeAssistantMessageId: undefined,
      busy: false,
      error: timeoutMessage,
      pendingToolConfirmation: undefined,
      status: 'idle',
      turnState: 'failed',
      updatedAt: timestamp,
    };
    const summary = sessionRow.summary_json
      ? parseJson<ExpirableBrowserChatRecord>(sessionRow.summary_json)
      : undefined;
    const terminalSummary = summary ? {
      ...summary,
      busy: false,
      error: timeoutMessage,
      pendingToolConfirmation: undefined,
      status: 'idle',
      turnState: 'failed',
      updatedAt: timestamp,
    } : terminalSession;
    database.prepare(`
      UPDATE browser_chat_session
      SET status = 'idle', revision = revision + 1,
          snapshot_json = ?, summary_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(terminalSession), JSON.stringify(terminalSummary), timestamp, sessionId);
    return true;
  });
}

export function expireStaleBrowserChatTurns(input: { maxAgeMs: number; userId?: string }) {
  const rows = getSqliteDatabase().prepare(`
    SELECT id FROM browser_chat_session
    WHERE (status = 'running' OR json_extract(snapshot_json, '$.busy') = 1)
      AND (? IS NULL OR user_id = ?)
  `).all(input.userId || null, input.userId || null) as Array<{ id: string }>;
  return rows.reduce((count, row) => (
    count + (expireBrowserChatSessionTurnIfNeeded(row.id, input.maxAgeMs) ? 1 : 0)
  ), 0);
}

function encodeCursor(cursor: HistoryCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeBrowserChatHistoryCursor(value: unknown, kind: BrowserChatHistoryKind): HistoryCursor | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<HistoryCursor>;
    if (parsed.kind !== kind || (typeof parsed.value !== 'string' && typeof parsed.value !== 'number')) return undefined;
    return {
      kind,
      value: parsed.value,
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
    };
  } catch {
    return undefined;
  }
}

export function browserChatHistoryLimit(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(numeric)));
}

function jsonPage<T>(rows: JsonHistoryRow[], kind: BrowserChatHistoryKind, limit: number): BrowserChatHistoryPage<T> {
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const oldest = selected.at(-1);
  const items = selected
    .map((row) => parseJson<T>(row.record_json))
    .filter((item): item is T => item !== undefined)
    .reverse();
  return {
    items,
    hasMore,
    cursor: hasMore && oldest
      ? encodeCursor({ kind, value: oldest.sort_value, id: oldest.id })
      : undefined,
  };
}

export function readBrowserChatMessagesPage<T>(
  sessionId: string,
  options: { cursor?: string; limit?: number } = {},
): BrowserChatHistoryPage<T> {
  const limit = browserChatHistoryLimit(options.limit, BROWSER_CHAT_MESSAGE_PAGE_SIZE);
  const cursor = decodeBrowserChatHistoryCursor(options.cursor, 'messages');
  const params: Array<string | number> = [sessionId];
  let cursorWhere = '';
  if (cursor && typeof cursor.value === 'string' && cursor.id) {
    cursorWhere = 'AND (time < ? OR (time = ? AND id < ?))';
    params.push(cursor.value, cursor.value, cursor.id);
  }
  params.push(limit + 1);
  const rows = getSqliteDatabase().prepare(`
    SELECT id, time AS sort_value, record_json
    FROM browser_chat_message
    WHERE session_id = ? ${cursorWhere}
    ORDER BY time DESC, id DESC
    LIMIT ?
  `).all(...params) as JsonHistoryRow[];
  return jsonPage<T>(rows, 'messages', limit);
}

export function readBrowserChatMessageById<T>(sessionId: string, messageId: string) {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) return undefined;
  const row = getSqliteDatabase().prepare(`
    SELECT record_json
    FROM browser_chat_message
    WHERE session_id = ? AND id = ?
  `).get(sessionId, normalizedMessageId) as { record_json?: string } | undefined;
  return row?.record_json ? parseJson<T>(row.record_json) : undefined;
}

export function readAllBrowserChatMessages<T>(sessionId: string) {
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json
    FROM browser_chat_message
    WHERE session_id = ?
    ORDER BY time ASC, id ASC
  `).all(sessionId) as Array<{ record_json: string }>;
  return rows
    .map((row) => parseJson<T>(row.record_json))
    .filter((item): item is T => item !== undefined);
}

export function readBrowserChatLatestActiveAssistantMessage<T>(sessionId: string) {
  const row = getSqliteDatabase().prepare(`
    SELECT record_json
    FROM browser_chat_message
    WHERE session_id = ?
      AND json_extract(record_json, '$.role') = 'assistant'
      AND json_extract(record_json, '$.status') IN ('running', 'blocked')
    ORDER BY time DESC, id DESC
    LIMIT 1
  `).get(sessionId) as { record_json?: string } | undefined;
  return row?.record_json ? parseJson<T>(row.record_json) : undefined;
}

export function readBrowserChatStepsPage<T>(
  sessionId: string,
  options: { cursor?: string; limit?: number } = {},
): BrowserChatHistoryPage<T> {
  const limit = browserChatHistoryLimit(options.limit, 120);
  const cursor = decodeBrowserChatHistoryCursor(options.cursor, 'steps');
  const params: Array<string | number> = [sessionId];
  let cursorWhere = '';
  if (cursor && typeof cursor.value === 'number') {
    cursorWhere = 'AND step_index < ?';
    params.push(cursor.value);
  }
  params.push(limit + 1);
  const rows = getSqliteDatabase().prepare(`
    SELECT CAST(step_index AS TEXT) AS id, step_index AS sort_value, record_json
    FROM browser_chat_step
    WHERE session_id = ? ${cursorWhere}
    ORDER BY step_index DESC
    LIMIT ?
  `).all(...params) as JsonHistoryRow[];
  return jsonPage<T>(rows, 'steps', limit);
}

export function readBrowserChatStepsByIndexes<T>(sessionId: string, stepIndexes: readonly number[]) {
  const normalizedIndexes = Array.from(new Set(stepIndexes.filter((index) => (
    Number.isInteger(index) && index >= 0
  )))).sort((left, right) => left - right);
  if (!normalizedIndexes.length) return [];

  const rows: Array<{ record_json: string }> = [];
  const chunkSize = 400;
  for (let offset = 0; offset < normalizedIndexes.length; offset += chunkSize) {
    const chunk = normalizedIndexes.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(...getSqliteDatabase().prepare(`
      SELECT record_json
      FROM browser_chat_step
      WHERE session_id = ? AND step_index IN (${placeholders})
      ORDER BY step_index ASC
    `).all(sessionId, ...chunk) as Array<{ record_json: string }>);
  }
  return rows
    .map((row) => parseJson<T>(row.record_json))
    .filter((item): item is T => item !== undefined);
}

export function readAllBrowserChatSteps<T>(sessionId: string) {
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json
    FROM browser_chat_step
    WHERE session_id = ?
    ORDER BY step_index ASC
  `).all(sessionId) as Array<{ record_json: string }>;
  return rows
    .map((row) => parseJson<T>(row.record_json))
    .filter((item): item is T => item !== undefined);
}

export function readBrowserChatLogsPage<T>(
  sessionId: string,
  options: { cursor?: string; limit?: number; messageId?: string } = {},
): BrowserChatHistoryPage<T> {
  const limit = browserChatHistoryLimit(options.limit, 200);
  const cursor = decodeBrowserChatHistoryCursor(options.cursor, 'logs');
  const params: Array<string | number> = [sessionId];
  let messageWhere = '';
  if (options.messageId?.trim()) {
    messageWhere = 'AND message_id = ?';
    params.push(options.messageId.trim());
  }
  let cursorWhere = '';
  if (cursor && typeof cursor.value === 'string' && cursor.id) {
    cursorWhere = 'AND (time < ? OR (time = ? AND id < ?))';
    params.push(cursor.value, cursor.value, cursor.id);
  }
  params.push(limit + 1);
  const rows = getSqliteDatabase().prepare(`
    SELECT id, time AS sort_value, record_json
    FROM browser_chat_log
    WHERE session_id = ? ${messageWhere} ${cursorWhere}
    ORDER BY time DESC, id DESC
    LIMIT ?
  `).all(...params) as JsonHistoryRow[];
  return jsonPage<T>(rows, 'logs', limit);
}

export function readBrowserChatSessionWindow<
  TSession extends { logs?: unknown[]; messages?: unknown[]; steps?: unknown[] },
  TMessage,
  TStep,
  TLog,
>(sessionId: string, options: { logLimit?: number; messageLimit?: number; stepLimit?: number } = {}) {
  const row = getSqliteDatabase().prepare(`
    SELECT snapshot_json FROM browser_chat_session WHERE id = ?
  `).get(sessionId) as { snapshot_json?: string } | undefined;
  const snapshot = row?.snapshot_json ? parseJson<TSession>(row.snapshot_json) : undefined;
  if (!snapshot) return undefined;
  const messages = readBrowserChatMessagesPage<TMessage>(sessionId, { limit: options.messageLimit });
  const steps = readBrowserChatStepsPage<TStep>(sessionId, { limit: options.stepLimit });
  const logs = readBrowserChatLogsPage<TLog>(sessionId, { limit: options.logLimit });
  return {
    ...snapshot,
    messages: messages.items,
    steps: steps.items,
    logs: logs.items,
    history: {
      messages: { cursor: messages.cursor, hasMore: messages.hasMore },
      steps: { cursor: steps.cursor, hasMore: steps.hasMore },
      logs: { cursor: logs.cursor, hasMore: logs.hasMore },
    } satisfies BrowserChatHistoryState,
  };
}

export function readBrowserChatSessionHeader<TSession>(sessionId: string) {
  const row = getSqliteDatabase().prepare(`
    SELECT snapshot_json FROM browser_chat_session WHERE id = ?
  `).get(sessionId) as { snapshot_json?: string } | undefined;
  return row?.snapshot_json ? parseJson<TSession>(row.snapshot_json) : undefined;
}

export function readBrowserChatSessionOwner(sessionId: string) {
  const row = getSqliteDatabase().prepare(`
    SELECT user_id FROM browser_chat_session WHERE id = ?
  `).get(sessionId) as { user_id?: string | null } | undefined;
  return row ? { userId: row.user_id || undefined } : undefined;
}
