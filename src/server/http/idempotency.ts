import { createHash } from 'node:crypto';
import { executeDatabase, queryDatabase, queryDatabaseOne, runDatabaseTransaction } from '@/server/db/database';
import { ApiRequestError, apiJson } from './api-request';
import { incrementMetric } from '@/server/observability/runtime-observability';
import { queueDatabaseWrite } from '@/server/storage/database-write-queue';

type IdempotencyRow = {
  request_hash: string;
  response_json?: string | null;
  state: string;
  status_code?: number | null;
};

const cleanupState = ((globalThis as typeof globalThis & {
  __apiIdempotencyCleanupState?: { lastAt: number };
}).__apiIdempotencyCleanupState ??= { lastAt: 0 });

function scheduleExpiredClaimCleanup(timestamp: string) {
  if (Date.now() - cleanupState.lastAt < 60 * 60 * 1000) return;
  cleanupState.lastAt = Date.now();
  void queueDatabaseWrite([{
    sql: 'DELETE FROM api_idempotency WHERE expires_at <= ?',
    params: [timestamp],
  }]).catch(() => {
    cleanupState.lastAt = 0;
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

export function idempotencyFingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function idempotencyTtlMs() {
  const configured = Number(process.env.API_IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000);
  return Number.isFinite(configured)
    ? Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(configured)))
    : 24 * 60 * 60 * 1000;
}

export async function runIdempotentJson(
  request: Request,
  input: { fingerprint: string; scope: string; userId: string },
  operation: () => Promise<Response> | Response,
) {
  const key = String(request.headers.get('idempotency-key') || '').trim();
  if (!key) return operation();
  if (!/^[a-zA-Z0-9._:-]{8,200}$/.test(key)) {
    throw new ApiRequestError('Idempotency-Key is invalid', { code: 'invalid_idempotency_key' });
  }
  const timestamp = new Date();
  const expiresAt = new Date(timestamp.getTime() + idempotencyTtlMs()).toISOString();
  const claim = await runDatabaseTransaction(async (database) => {
    await executeDatabase(`
      DELETE FROM api_idempotency
      WHERE user_id = ? AND scope = ? AND idempotency_key = ? AND expires_at <= ?
    `, [input.userId, input.scope, key, timestamp.toISOString()], database);
    const inserted = await queryDatabase<{ user_id: string }>(`
      INSERT INTO api_idempotency (
        user_id, scope, idempotency_key, request_hash, state, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(user_id, scope, idempotency_key) DO NOTHING
      RETURNING user_id
    `, [input.userId, input.scope, key, input.fingerprint, expiresAt, timestamp.toISOString(), timestamp.toISOString()], database);
    if (inserted.length) return { owned: true as const };
    const row = await queryDatabaseOne<IdempotencyRow>(`
      SELECT request_hash, response_json, state, status_code
      FROM api_idempotency
      WHERE user_id = ? AND scope = ? AND idempotency_key = ?
    `, [input.userId, input.scope, key], database);
    return { owned: false as const, row };
  });
  if (!claim.owned) {
    scheduleExpiredClaimCleanup(timestamp.toISOString());
    if (!claim.row || claim.row.request_hash !== input.fingerprint) {
      incrementMetric('api_idempotency_conflict_total', { scope: input.scope });
      throw new ApiRequestError('Idempotency-Key was already used with a different request', {
        code: 'idempotency_conflict',
        status: 409,
      });
    }
    if (claim.row.state !== 'completed' || !claim.row.response_json) {
      throw new ApiRequestError('An identical request is still being processed', {
        code: 'request_in_progress',
        status: 409,
      });
    }
    incrementMetric('api_idempotency_replay_total', { scope: input.scope });
    return apiJson(request, JSON.parse(claim.row.response_json), {
      status: claim.row.status_code || 200,
      headers: { 'x-idempotency-replayed': '1' },
    });
  }

  try {
    const response = await operation();
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const responseJson = await response.clone().text();
      await executeDatabase(`
        UPDATE api_idempotency
        SET state = 'completed', status_code = ?, response_json = ?, updated_at = ?
        WHERE user_id = ? AND scope = ? AND idempotency_key = ? AND request_hash = ?
      `, [
        response.status,
        responseJson,
        new Date().toISOString(),
        input.userId,
        input.scope,
        key,
        input.fingerprint,
      ]);
    } else {
      await executeDatabase(`
        DELETE FROM api_idempotency WHERE user_id = ? AND scope = ? AND idempotency_key = ?
      `, [input.userId, input.scope, key]);
    }
    scheduleExpiredClaimCleanup(timestamp.toISOString());
    return response;
  } catch (error) {
    await executeDatabase(`
      DELETE FROM api_idempotency WHERE user_id = ? AND scope = ? AND idempotency_key = ?
    `, [input.userId, input.scope, key]);
    scheduleExpiredClaimCleanup(timestamp.toISOString());
    throw error;
  }
}
