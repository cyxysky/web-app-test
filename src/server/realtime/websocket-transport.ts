import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Socket } from 'node:net';

function encodeWebSocketFrame(opcode: number, payload: Buffer) {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function encodeWebSocketText(payload: string) {
  return encodeWebSocketFrame(0x1, Buffer.from(payload));
}

export function encodeWebSocketBinary(payload: Buffer) {
  return encodeWebSocketFrame(0x2, payload);
}

export function encodeWebSocketControl(opcode: 0x8 | 0x9 | 0xA, payload: Uint8Array = new Uint8Array()) {
  return encodeWebSocketFrame(opcode, Buffer.from(payload.subarray(0, 125)));
}

export function acceptWebSocketUpgrade(request: http.IncomingMessage, socket: Socket) {
  const key = String(request.headers['sec-websocket-key'] || '');
  if (!key) return false;
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
  return true;
}

export function consumeWebSocketFrames(
  previousBuffer: Buffer,
  chunk: Buffer,
  handlers: {
    onClose: () => void;
    onPing: (payload: Buffer) => void;
    onText?: (payload: string) => void;
    onBinary?: (payload: Buffer) => void;
    onProtocolError?: () => void;
  },
) {
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
      const bigLength = buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        handlers.onProtocolError?.();
        return Buffer.alloc(0);
      }
      length = Number(bigLength);
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
    else if (opcode === 0x1) handlers.onText?.(decoded.toString('utf8'));
    else if (opcode === 0x2) handlers.onBinary?.(decoded);
  }
  return buffer;
}

export function listenWebSocketServer(
  server: http.Server,
  port: number,
  options: { host: string; nextPortOnAddressInUse?: boolean; addressInUseMessage?: (port: number) => string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = () => {
      cleanup();
      resolve(port);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'EADDRINUSE' && options.nextPortOnAddressInUse) {
        listenWebSocketServer(server, port + 1, options).then(resolve, reject);
        return;
      }
      if (error.code === 'EADDRINUSE' && options.addressInUseMessage) {
        reject(new Error(options.addressInUseMessage(port)));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, options.host);
  });
}
