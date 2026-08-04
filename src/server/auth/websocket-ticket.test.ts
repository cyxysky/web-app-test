import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeSqliteDatabase, getSqliteDatabase } from '@/server/storage/sqlite-database';
import { consumeWebSocketTicket, createWebSocketTicket } from './websocket-ticket';

test('websocket tickets are short-lived, scoped, origin-bound, and one-time', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-ticket-'));
  const previousDataRoot = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = dataRoot;

  try {
    getSqliteDatabase();

    const preview = createWebSocketTicket({
      origin: 'https://WEBPILOT.test:443',
      scope: 'browser-preview',
      sessionId: 'session-1',
      userId: 'user-1',
    });
    assert.match(preview.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(consumeWebSocketTicket({
      origin: 'https://evil.test',
      scope: 'browser-preview',
      sessionId: 'session-1',
      ticket: preview.ticket,
    }), undefined);
    assert.deepEqual(consumeWebSocketTicket({
      origin: 'https://webpilot.test',
      scope: 'browser-preview',
      sessionId: 'session-1',
      ticket: preview.ticket,
    }), {
      scope: 'browser-preview',
      sessionId: 'session-1',
      userId: 'user-1',
    });
    assert.equal(consumeWebSocketTicket({
      origin: 'https://webpilot.test',
      scope: 'browser-preview',
      sessionId: 'session-1',
      ticket: preview.ticket,
    }), undefined);

    const refresh = createWebSocketTicket({
      origin: 'https://webpilot.test',
      scope: 'realtime-refresh',
      userId: 'user-1',
    });
    assert.equal(consumeWebSocketTicket({
      origin: 'https://webpilot.test',
      scope: 'browser-preview',
      ticket: refresh.ticket,
    }), undefined);
    assert.equal(consumeWebSocketTicket({
      origin: 'https://webpilot.test',
      scope: 'realtime-refresh',
      ticket: refresh.ticket,
    })?.userId, 'user-1');
  } finally {
    closeSqliteDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
