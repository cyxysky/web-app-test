import { getSqliteDatabase } from './sqlite-database';

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
  const limit = browserChatHistoryLimit(options.limit, 80);
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
