import { getSqliteDatabase, parseSqliteJson, runSqliteTransaction } from './sqlite-database';

import { publishBrowserChatRuntimeRecordsChanged } from './browser-chat-runtime-record-refresh';

export const BROWSER_CODE_RUNTIME_STATE_MAX_KEYS = 100;
export const BROWSER_CODE_RUNTIME_STATE_MAX_KEY_CHARS = 120;
export const BROWSER_CODE_RUNTIME_STATE_MAX_VALUE_BYTES = 256 * 1024;
export const BROWSER_CODE_RUNTIME_STATE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const runtimeStateNamespace = 'conversation';

export type BrowserCodeRuntimeStateOperation = {
  action: 'clear' | 'delete' | 'get' | 'list' | 'set';
  input?: unknown;
};

export type BrowserCodeRuntimeStateEntry = {
  key: string;
  value: unknown;
  revision: number;
  updatedAt: string;
  expiresAt?: string;
};

export type BrowserCodeRuntimeStateGetResult =
  | ({ found: true } & BrowserCodeRuntimeStateEntry)
  | { found: false; key: string };

type RuntimeStateRow = {
  key: string;
  value_json: string;
  revision: number;
  updated_at: string;
  expires_at: string | null;
};

function inputRecord(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, name: string, allowed: string[]) {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${name} has unsupported field: ${unknown}.`);
}

function normalizedSessionId(value: unknown) {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId || sessionId.length > 240 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error('agent.state is unavailable because the browser conversation state scope is invalid.');
  }
  return sessionId;
}

function normalizedKey(value: unknown, name = 'agent.state key') {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > BROWSER_CODE_RUNTIME_STATE_MAX_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error(`${name} must be 1-${BROWSER_CODE_RUNTIME_STATE_MAX_KEY_CHARS} printable characters.`);
  }
  return key;
}

function normalizedPrefix(value: unknown) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > BROWSER_CODE_RUNTIME_STATE_MAX_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`agent.state prefix must contain at most ${BROWSER_CODE_RUNTIME_STATE_MAX_KEY_CHARS} printable characters.`);
  }
  return value;
}

function optionalRevision(value: unknown) {
  if (value === undefined) return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0 || revision > Number.MAX_SAFE_INTEGER) {
    throw new Error('agent.state expectedRevision must be a non-negative safe integer.');
  }
  return revision;
}

function optionalTtlMs(value: unknown) {
  if (value === undefined) return undefined;
  const ttlMs = Number(value);
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > BROWSER_CODE_RUNTIME_STATE_MAX_TTL_MS) {
    throw new Error(`agent.state ttlMs must be an integer between 1000 and ${BROWSER_CODE_RUNTIME_STATE_MAX_TTL_MS}.`);
  }
  return ttlMs;
}

function serializeRuntimeStateValue(value: unknown) {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 30) throw new Error('agent.state value exceeds the maximum nesting depth of 30.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('agent.state value numbers must be finite.');
      return;
    }
    if (typeof item !== 'object') {
      throw new Error('agent.state value must contain only JSON-safe values.');
    }
    if (seen.has(item)) throw new Error('agent.state value must not contain circular references.');
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('agent.state value objects must be plain JSON records.');
      }
      for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('agent.state value must be JSON-serializable.');
  if (Buffer.byteLength(serialized, 'utf8') > BROWSER_CODE_RUNTIME_STATE_MAX_VALUE_BYTES) {
    throw new Error(
      `agent.state values are limited to ${BROWSER_CODE_RUNTIME_STATE_MAX_VALUE_BYTES} UTF-8 bytes. `
      + 'Store images and large text as workspace artifact files, not Base64 conversation state.',
    );
  }
  const oversizedBase64 = /"(?:b64|base64|data)"\s*:\s*"(?:data:[^;"]+;base64,)?[A-Za-z0-9+/=]{65536,}"/i.test(serialized)
    || /"data:[^;"]+;base64,[A-Za-z0-9+/=]{65536,}"/i.test(serialized);
  if (oversizedBase64) {
    throw new Error('agent.state must not store large Base64 payloads. Save the bytes as a workspace artifact file and store only its asset name.');
  }
  return serialized;
}

function purgeExpiredState(database: ReturnType<typeof getSqliteDatabase>, timestamp: string) {
  database.prepare(`
    DELETE FROM browser_code_runtime_state
    WHERE expires_at IS NOT NULL AND expires_at <= ?
  `).run(timestamp);
}

function stateEntry(row: RuntimeStateRow) {
  return {
    key: row.key,
    value: parseSqliteJson<unknown>(row.value_json, null),
    revision: Number(row.revision) || 0,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

function currentRow(sessionId: string, key: string) {
  return getSqliteDatabase().prepare(`
    SELECT key, value_json, revision, updated_at, expires_at
    FROM browser_code_runtime_state
    WHERE session_id = ? AND namespace = ? AND key = ?
  `).get(sessionId, runtimeStateNamespace, key) as RuntimeStateRow | undefined;
}

export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation & { action: 'get' },
): BrowserCodeRuntimeStateGetResult;
export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation & { action: 'set' },
): BrowserCodeRuntimeStateEntry;
export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation & { action: 'delete' },
): { deleted: boolean; key: string; revision?: number };
export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation & { action: 'list' },
): { items: BrowserCodeRuntimeStateEntry[]; count: number; truncated: boolean };
export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation & { action: 'clear' },
): { deleted: number; prefix: string };
export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation,
): BrowserCodeRuntimeStateEntry | BrowserCodeRuntimeStateGetResult
  | { deleted: boolean; key: string; revision?: number }
  | { items: BrowserCodeRuntimeStateEntry[]; count: number; truncated: boolean }
  | { deleted: number; prefix: string };
export function executeBrowserCodeRuntimeStateOperation(
  rawSessionId: string,
  operation: BrowserCodeRuntimeStateOperation,
): BrowserCodeRuntimeStateEntry | BrowserCodeRuntimeStateGetResult
  | { deleted: boolean; key: string; revision?: number }
  | { items: BrowserCodeRuntimeStateEntry[]; count: number; truncated: boolean }
  | { deleted: number; prefix: string } {
  const sessionId = normalizedSessionId(rawSessionId);
  const input = inputRecord(operation.input ?? {}, `agent.state.${operation.action} input`);
  const timestamp = new Date().toISOString();

  if (operation.action === 'get') {
    rejectUnknownFields(input, 'agent.state.get input', ['key']);
    const key = normalizedKey(input.key);
    return runSqliteTransaction((database) => {
      purgeExpiredState(database, timestamp);
      const row = currentRow(sessionId, key);
      return row ? { found: true, ...stateEntry(row) } : { found: false, key };
    });
  }

  if (operation.action === 'set') {
    rejectUnknownFields(input, 'agent.state.set input', ['key', 'value', 'expectedRevision', 'ttlMs']);
    if (!Object.prototype.hasOwnProperty.call(input, 'value')) {
      throw new Error('agent.state.set input requires value.');
    }
    const key = normalizedKey(input.key);
    const valueJson = serializeRuntimeStateValue(input.value);
    const expectedRevision = optionalRevision(input.expectedRevision);
    const ttlMs = optionalTtlMs(input.ttlMs);
    const result = runSqliteTransaction((database) => {
      purgeExpiredState(database, timestamp);
      const existing = currentRow(sessionId, key);
      const currentRevision = Number(existing?.revision) || 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new Error(`agent.state revision conflict for key ${JSON.stringify(key)}: expected ${expectedRevision}, current ${currentRevision}.`);
      }
      const aggregate = database.prepare(`
        SELECT COUNT(*) AS key_count
        FROM browser_code_runtime_state
        WHERE session_id = ? AND namespace = ?
      `).get(sessionId, runtimeStateNamespace) as { key_count?: number };
      const keyCount = Number(aggregate.key_count) || 0;
      if (!existing && keyCount >= BROWSER_CODE_RUNTIME_STATE_MAX_KEYS) {
        throw new Error(`agent.state stores at most ${BROWSER_CODE_RUNTIME_STATE_MAX_KEYS} keys per conversation.`);
      }
      const revision = currentRevision + 1;
      const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs).toISOString();
      database.prepare(`
        INSERT INTO browser_code_runtime_state (
          session_id, namespace, key, value_json, revision, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, namespace, key) DO UPDATE SET
          value_json = excluded.value_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `).run(sessionId, runtimeStateNamespace, key, valueJson, revision, timestamp, expiresAt);
      return {
        key,
        value: parseSqliteJson<unknown>(valueJson, null),
        revision,
        updatedAt: timestamp,
        ...(expiresAt ? { expiresAt } : {}),
      };
    });
    publishBrowserChatRuntimeRecordsChanged(sessionId, 'variables');
    return result;
  }

  if (operation.action === 'delete') {
    rejectUnknownFields(input, 'agent.state.delete input', ['key', 'expectedRevision']);
    const key = normalizedKey(input.key);
    const expectedRevision = optionalRevision(input.expectedRevision);
    const result = runSqliteTransaction((database) => {
      purgeExpiredState(database, timestamp);
      const existing = currentRow(sessionId, key);
      const currentRevision = Number(existing?.revision) || 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new Error(`agent.state revision conflict for key ${JSON.stringify(key)}: expected ${expectedRevision}, current ${currentRevision}.`);
      }
      if (!existing) return { deleted: false, key };
      database.prepare(`
        DELETE FROM browser_code_runtime_state
        WHERE session_id = ? AND namespace = ? AND key = ?
      `).run(sessionId, runtimeStateNamespace, key);
      return { deleted: true, key, revision: currentRevision };
    });
    if (result.deleted) publishBrowserChatRuntimeRecordsChanged(sessionId, 'variables');
    return result;
  }

  if (operation.action === 'list') {
    rejectUnknownFields(input, 'agent.state.list input', ['prefix', 'limit']);
    const prefix = normalizedPrefix(input.prefix);
    const requestedLimit = input.limit === undefined ? BROWSER_CODE_RUNTIME_STATE_MAX_KEYS : Number(input.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > BROWSER_CODE_RUNTIME_STATE_MAX_KEYS) {
      throw new Error(`agent.state list limit must be an integer between 1 and ${BROWSER_CODE_RUNTIME_STATE_MAX_KEYS}.`);
    }
    const result = runSqliteTransaction((database) => {
      purgeExpiredState(database, timestamp);
      const matching = (database.prepare(`
        SELECT key, value_json, revision, updated_at, expires_at
        FROM browser_code_runtime_state
        WHERE session_id = ? AND namespace = ?
        ORDER BY key ASC
      `).all(sessionId, runtimeStateNamespace) as RuntimeStateRow[])
        .filter((row) => row.key.startsWith(prefix));
      return {
        items: matching.slice(0, requestedLimit).map(stateEntry),
        count: matching.length,
        truncated: matching.length > requestedLimit,
      };
    });
    return result;
  }

  if (operation.action === 'clear') {
    rejectUnknownFields(input, 'agent.state.clear input', ['prefix']);
    const prefix = normalizedPrefix(input.prefix);
    const result = runSqliteTransaction((database) => {
      purgeExpiredState(database, timestamp);
      const keys = (database.prepare(`
        SELECT key FROM browser_code_runtime_state
        WHERE session_id = ? AND namespace = ?
      `).all(sessionId, runtimeStateNamespace) as Array<{ key: string }>)
        .map((row) => row.key)
        .filter((key) => key.startsWith(prefix));
      if (!keys.length) return { deleted: 0, prefix };
      const placeholders = keys.map(() => '?').join(', ');
      database.prepare(`
        DELETE FROM browser_code_runtime_state
        WHERE session_id = ? AND namespace = ? AND key IN (${placeholders})
      `).run(sessionId, runtimeStateNamespace, ...keys);
      return { deleted: keys.length, prefix };
    });
    if (result.deleted) publishBrowserChatRuntimeRecordsChanged(sessionId, 'variables');
    return result;
  }

  throw new Error(`Unsupported agent.state action: ${String(operation.action)}.`);
}

