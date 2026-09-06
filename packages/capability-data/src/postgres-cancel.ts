import { createConnection } from 'node:net';

export type PostgresCancelableClient = {
  processID: number; secretKey: number;
  connectionParameters: { host: string; port: number };
};

/** PostgreSQL CancelRequest uses a separate socket, so cancellation never waits for a pool slot. */
export function cancelPostgresQuery(client: PostgresCancelableClient): Promise<void> {
  return new Promise((resolve) => {
    const { host, port } = client.connectionParameters;
    const socket = host.startsWith('/') ? createConnection(`${host}/.s.PGSQL.${port}`) : createConnection({ host, port });
    const finish = () => { socket.destroy(); resolve(); };
    socket.setTimeout(2000, finish);
    socket.once('error', finish);
    socket.once('close', resolve);
    socket.once('connect', () => {
      const packet = Buffer.alloc(16);
      packet.writeInt32BE(16, 0); packet.writeInt32BE(80877102, 4);
      packet.writeInt32BE(client.processID, 8); packet.writeInt32BE(client.secretKey, 12);
      socket.end(packet);
    });
  });
}
