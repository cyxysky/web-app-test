/* eslint-disable @typescript-eslint/no-require-imports */
const { createHash } = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REFRESH_SERVICE_NAME = 'webpilot-refresh-websocket';
const REFRESH_SERVICE_HEADER = 'x-webpilot-refresh-service';
const MAX_PUBLISH_BODY_BYTES = 8 * 1024 * 1024;

function encodeFrame(opcode, payload) {
  const content = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (content.length < 126) {
    header = Buffer.from([0x80 | opcode, content.length]);
  } else if (content.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(content.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(content.length), 2);
  }
  return Buffer.concat([header, content]);
}

function consumeFrames(previousBuffer, chunk, handlers) {
  let buffer = Buffer.concat([previousBuffer, chunk]);
  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return buffer;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return buffer;
      const largeLength = buffer.readBigUInt64BE(offset);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        handlers.onClose();
        return Buffer.alloc(0);
      }
      length = Number(largeLength);
      offset += 8;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return buffer;
    const payload = buffer.subarray(offset, offset + length);
    const decoded = masked
      ? Buffer.from(payload.map((byte, index) => byte ^ buffer[maskOffset + (index % 4)]))
      : Buffer.from(payload);
    buffer = buffer.subarray(offset + length);
    if (opcode === 0x8) {
      handlers.onClose();
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) handlers.onPing(decoded);
  }
  return buffer;
}

function normalizedOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function parseRefreshEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (
    value.type !== 'refresh'
    || !['automationCase', 'automationRun', 'automationSchedule', 'browserChatSession'].includes(String(value.entityType))
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.updatedAt !== 'string'
    || typeof value.version !== 'number'
    || !Number.isFinite(value.version)
    || typeof value.userId !== 'string'
    || !value.userId
  ) return undefined;
  return value;
}

function createRealtimeRefreshHub(options) {
  const clients = new Set();
  let database;
  const pending = [];
  const databasePath = path.join(
    path.resolve(process.env.APP_DATA_DIR || path.join(options.appDir, 'runtime')),
    '.data',
    'webpilot.db',
  );

  const databaseConnection = () => {
    if (database) return database;
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout = 5000');
    return database;
  };

  const removeClient = (client) => {
    clients.delete(client);
    client.socket.destroy();
  };

  const send = (client, payload) => {
    if (client.socket.destroyed) return false;
    try {
      client.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(payload))));
      return true;
    } catch {
      removeClient(client);
      return false;
    }
  };

  const broadcast = (payload, userId) => {
    for (const client of [...clients]) {
      if (userId && client.userId !== userId) continue;
      if (!send(client, payload)) clients.delete(client);
    }
  };

  const flushPending = () => {
    if (!clients.size || !pending.length) return;
    const connectedUsers = new Set([...clients].map((client) => client.userId));
    const deliverable = pending.filter((event) => connectedUsers.has(event.userId));
    const retained = pending.filter((event) => !connectedUsers.has(event.userId));
    pending.splice(0, pending.length, ...retained);
    for (const event of deliverable) broadcast(event, event.userId);
  };

  const publish = (event) => {
    pending.push(event);
    if (pending.length > 500) pending.splice(0, pending.length - 500);
    flushPending();
  };

  const consumeTicket = (ticket, origin) => {
    if (!ticket) return undefined;
    const connection = databaseConnection();
    const tokenHash = createHash('sha256').update(ticket, 'utf8').digest('hex');
    connection.exec('BEGIN IMMEDIATE');
    try {
      const row = connection.prepare(`
        SELECT id, user_id, scope, origin, expires_at, consumed_at
        FROM websocket_ticket WHERE token_hash = ?
      `).get(tokenHash);
      const current = new Date().toISOString();
      if (
        !row
        || row.consumed_at
        || row.expires_at <= current
        || row.scope !== 'realtime-refresh'
        || (row.origin && row.origin !== normalizedOrigin(origin))
      ) {
        connection.exec('ROLLBACK');
        return undefined;
      }
      const updated = connection.prepare(`
        UPDATE websocket_ticket SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(current, row.id, current);
      connection.exec('COMMIT');
      return Number(updated.changes || 0) === 1 ? { userId: row.user_id } : undefined;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  };

  const acceptUpgrade = (request, socket, requestUrl) => {
    let auth;
    try {
      auth = consumeTicket(requestUrl.searchParams.get('ticket') || '', request.headers.origin);
    } catch {
      socket.destroy();
      return;
    }
    const key = String(request.headers['sec-websocket-key'] || '');
    if (!auth || !key) {
      socket.destroy();
      return;
    }
    const acceptKey = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n'));
    const client = { buffer: Buffer.alloc(0), socket, userId: auth.userId };
    clients.add(client);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      client.buffer = consumeFrames(client.buffer, chunk, {
        onClose: () => removeClient(client),
        onPing: (payload) => socket.write(encodeFrame(0xA, payload.subarray(0, 125))),
      });
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => removeClient(client));
    send(client, { type: 'hello', connectedAt: new Date().toISOString() });
    flushPending();
  };

  const readPublishBody = (request) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PUBLISH_BODY_BYTES) {
        reject(new Error('Realtime publish payload is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

  const handlePublish = async (request, response) => {
    if (
      request.method !== 'POST'
      || request.headers['x-webpilot-realtime-token'] !== process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN
    ) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    try {
      const event = parseRefreshEvent(JSON.parse(await readPublishBody(request)));
      if (!event) throw new Error('Invalid refresh event');
      publish(event);
      response.writeHead(202, {
        'Content-Type': 'application/json; charset=utf-8',
        [REFRESH_SERVICE_HEADER]: REFRESH_SERVICE_NAME,
      });
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      if (response.headersSent) return;
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid refresh event' }));
    }
  };

  const heartbeat = setInterval(() => {
    broadcast({ type: 'heartbeat', time: new Date().toISOString() });
  }, 25_000);
  heartbeat.unref?.();

  return {
    acceptUpgrade,
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.socket.destroy();
      clients.clear();
      database?.close();
      database = undefined;
    },
    handlePublish,
  };
}

module.exports = { createRealtimeRefreshHub };
