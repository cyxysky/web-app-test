import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSqliteDatabase, runSqliteTransaction } from '@/server/storage/sqlite-database';

export type WebSocketTicketScope = 'browser-preview' | 'realtime-refresh';

type WebSocketTicketRow = {
  id: string;
  user_id: string;
  session_id?: string | null;
  scope: string;
  origin?: string | null;
  expires_at: string;
  consumed_at?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function ticketHash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function ticketLifetimeMs() {
  const configured = Number(process.env.WEBPILOT_WEBSOCKET_TICKET_TTL_SECONDS || 45);
  const seconds = Number.isFinite(configured)
    ? Math.max(15, Math.min(120, Math.floor(configured)))
    : 45;
  return seconds * 1000;
}

export function requestPublicOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedHost = String(request.headers.get('x-forwarded-host') || '').split(',')[0].trim();
  const forwardedProto = String(request.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
  const host = forwardedHost || request.headers.get('host') || url.host;
  const protocol = forwardedProto || url.protocol.replace(/:$/, '');
  return new URL(`${protocol}://${host}`).origin;
}

export function createWebSocketTicket(input: {
  origin: string;
  scope: WebSocketTicketScope;
  sessionId?: string;
  userId: string;
}) {
  const origin = normalizedOrigin(input.origin);
  if (!origin) throw new Error('A valid WebSocket origin is required');
  const token = randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ticketLifetimeMs()).toISOString();
  const database = getSqliteDatabase();
  database.prepare(`
    INSERT INTO websocket_ticket (
      id, token_hash, user_id, session_id, scope, origin, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    ticketHash(token),
    input.userId,
    input.sessionId || null,
    input.scope,
    origin,
    expiresAt,
    createdAt,
  );
  database.prepare('DELETE FROM websocket_ticket WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(createdAt);
  return { expiresAt, ticket: token };
}

export function consumeWebSocketTicket(input: {
  origin?: string;
  scope: WebSocketTicketScope;
  sessionId?: string;
  ticket: string;
}) {
  const token = input.ticket.trim();
  if (!token) return undefined;
  return runSqliteTransaction((database) => {
    const row = database.prepare(`
      SELECT id, user_id, session_id, scope, origin, expires_at, consumed_at
      FROM websocket_ticket WHERE token_hash = ?
    `).get(ticketHash(token)) as WebSocketTicketRow | undefined;
    const current = nowIso();
    const expectedOrigin = normalizedOrigin(String(input.origin || '').trim());
    if (
      !row
      || row.consumed_at
      || row.expires_at <= current
      || row.scope !== input.scope
      || String(row.session_id || '') !== String(input.sessionId || '')
      || (row.origin && row.origin !== expectedOrigin)
    ) return undefined;
    const updated = database.prepare(`
      UPDATE websocket_ticket SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(current, row.id, current);
    if (Number(updated.changes || 0) !== 1) return undefined;
    return {
      userId: row.user_id,
      sessionId: row.session_id || undefined,
      scope: row.scope as WebSocketTicketScope,
    };
  });
}
