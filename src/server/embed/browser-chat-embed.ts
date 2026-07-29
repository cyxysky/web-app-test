import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { joinWebPilotUrl, WEBPILOT_BASE_PATH } from '@/lib/webpilot-base-path';

type EmbedTokenClaims = {
  version: 1;
  sessionId: string;
  userId: string;
  origin?: string;
  iat: number;
  exp: number;
};

export type EmbedAuthContext = EmbedTokenClaims & {
  token: string;
};

export class EmbedAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'EmbedAuthError';
    this.status = status;
  }
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate',
  Expires: '0',
  Pragma: 'no-cache',
  'Surrogate-Control': 'no-store',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-WebPilot-Embed-Token',
  'Access-Control-Max-Age': '600',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function withEmbedHeaders(headers: Headers, cacheable = false) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  if (!cacheable) {
    for (const [key, value] of Object.entries(NO_STORE_HEADERS)) headers.set(key, value);
  }
  return headers;
}

export function embedJson<T>(body: T, init: ResponseInit = {}) {
  const headers = withEmbedHeaders(new Headers(init.headers));
  return NextResponse.json(body, { ...init, headers });
}

export function embedOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: withEmbedHeaders(new Headers()),
  });
}

export function embedJavaScript(source: string) {
  const headers = withEmbedHeaders(new Headers({
    'Content-Type': 'application/javascript; charset=utf-8',
  }), true);
  headers.set('Cache-Control', 'public, max-age=60, must-revalidate');
  return new Response(source, { headers });
}

function tokenSecret() {
  return process.env.WEBPILOT_EMBED_TOKEN_SECRET
    || process.env.AI_EMBED_TOKEN_SECRET
    || process.env.NEXTAUTH_SECRET
    || process.env.AI_API_KEY
    || 'webpilot-qa-local-embed-secret';
}

function toBase64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input: string) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function signPayload(payload: string) {
  return toBase64Url(crypto.createHmac('sha256', tokenSecret()).update(payload).digest());
}

function safeTimingEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createEmbedToken(input: {
  sessionId: string;
  userId?: string | number;
  origin?: string | null;
  ttlSeconds?: number;
}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, Math.min(input.ttlSeconds || 12 * 60 * 60, 7 * 24 * 60 * 60));
  const claims: EmbedTokenClaims = {
    version: 1,
    sessionId: input.sessionId,
    userId: normalizeString(input.userId),
    origin: normalizeString(input.origin) || undefined,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const payload = toBase64Url(JSON.stringify(claims));
  const signature = signPayload(payload);
  return {
    token: `${payload}.${signature}`,
    claims,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

export function verifyEmbedToken(token: string, expectedSessionId?: string): EmbedTokenClaims {
  const normalized = token.trim();
  const [payload, signature, extra] = normalized.split('.');
  if (!payload || !signature || extra) throw new EmbedAuthError('Invalid embed token');
  const expectedSignature = signPayload(payload);
  if (!safeTimingEqual(signature, expectedSignature)) throw new EmbedAuthError('Invalid embed token');

  let claims: EmbedTokenClaims;
  try {
    claims = JSON.parse(fromBase64Url(payload).toString('utf8')) as EmbedTokenClaims;
  } catch {
    throw new EmbedAuthError('Invalid embed token');
  }

  if (claims.version !== 1 || !claims.sessionId || typeof claims.exp !== 'number') {
    throw new EmbedAuthError('Invalid embed token');
  }
  if (expectedSessionId && claims.sessionId !== expectedSessionId) {
    throw new EmbedAuthError('Embed token does not match session', 403);
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new EmbedAuthError('Embed token expired', 401);
  }
  return claims;
}

export function readEmbedAuth(request: NextRequest | Request, expectedSessionId?: string): EmbedAuthContext {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const url = new URL(request.url);
  const token = bearer
    || request.headers.get('x-webpilot-embed-token')
    || url.searchParams.get('token')
    || '';
  if (!token) throw new EmbedAuthError('Missing embed token');
  return { ...verifyEmbedToken(token, expectedSessionId), token };
}

export function embedErrorJson(error: unknown, fallback = 'Embed request failed') {
  if (error instanceof EmbedAuthError) {
    return embedJson({ error: error.message }, { status: error.status });
  }
  return embedJson(
    { error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  );
}

export function normalizeString(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function normalizeMode(value: unknown) {
  return value === 'dom' ? 'dom' : 'code';
}

export function normalizeSafetyMode(value: unknown) {
  return value === 'full' ? 'full' : 'strict';
}

export function publicBaseUrl(request: NextRequest | Request) {
  const configuredUrl = normalizeString(process.env.WEBPILOT_PUBLIC_BASE_URL);
  if (configuredUrl) return configuredUrl.replace(/\/+$/g, '');
  const requestUrl = new URL(request.url);
  const forwardedHost = normalizeString(request.headers.get('x-forwarded-host')).split(',')[0];
  const forwardedProto = normalizeString(request.headers.get('x-forwarded-proto')).split(',')[0];
  const publicOrigin = forwardedHost
    ? `${forwardedProto || requestUrl.protocol.replace(/:$/, '')}://${forwardedHost}`
    : requestUrl.origin;
  return joinWebPilotUrl(publicOrigin, WEBPILOT_BASE_PATH).replace(/\/+$/g, '');
}

export function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  return normalizeString(body?.userId)
    || normalizeString(body?.qzUserId)
    || normalizeString(request.nextUrl.searchParams.get('userId'))
    || normalizeString(request.nextUrl.searchParams.get('qzUserId'));
}

export function requestOrigin(request: NextRequest | Request) {
  return normalizeString(request.headers.get('origin'));
}
