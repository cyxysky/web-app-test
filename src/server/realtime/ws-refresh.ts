import http from 'node:http';

export type RefreshEntityType =
  | 'automationCase'
  | 'automationRun'
  | 'automationSchedule'
  | 'browserChatSession';

export type RefreshWebSocketEvent = {
  type: 'refresh';
  entityType: RefreshEntityType;
  id: string;
  updatedAt: string;
  version: number;
  userId: string;
  deleted?: boolean;
  patch?: unknown;
};

type RefreshPublishState = {
  publishQueues: Map<string, Promise<void>>;
  versions: Map<string, number>;
};

const runtimeState = ((globalThis as typeof globalThis & {
  __webpilotRefreshPublishState?: RefreshPublishState;
}).__webpilotRefreshPublishState ??= {
  publishQueues: new Map<string, Promise<void>>(),
  versions: new Map<string, number>(),
});

export function parseRealtimeRefreshEvent(value: unknown): RefreshWebSocketEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<RefreshWebSocketEvent>;
  if (
    candidate.type !== 'refresh'
    || !['automationCase', 'automationRun', 'automationSchedule', 'browserChatSession'].includes(String(candidate.entityType))
    || typeof candidate.id !== 'string'
    || !candidate.id
    || typeof candidate.updatedAt !== 'string'
    || typeof candidate.version !== 'number'
    || !Number.isFinite(candidate.version)
    || typeof candidate.userId !== 'string'
    || !candidate.userId
  ) return undefined;
  return candidate as RefreshWebSocketEvent;
}

function publishToMainServer(event: RefreshWebSocketEvent) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const body = JSON.stringify(event);
    const request = http.request({
      host: '127.0.0.1',
      port: Math.max(1, Math.floor(Number(process.env.PORT || 3000))),
      path: '/_webpilot/realtime/publish',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-webpilot-realtime-token': process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN || '',
      },
    }, (response) => {
      response.resume();
      response.once('error', (error) => finish(error));
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
        finish();
        return;
      }
      finish(new Error(`Realtime publish returned ${response.statusCode || 0}`));
    });
    request.setTimeout(3_000, () => request.destroy(new Error('Realtime publish timed out')));
    request.once('error', (error) => finish(error));
    request.end(body);
  });
}

export function publishRealtimeRefreshEvent(input: {
  deleted?: boolean;
  entityType: RefreshEntityType;
  id: string;
  patch?: unknown;
  updatedAt?: string;
  userId: string;
}) {
  if (!input.id) return Promise.resolve();
  const key = `${input.entityType}:${input.id}`;
  const version = Math.max((runtimeState.versions.get(key) || 0) + 1, Date.now());
  runtimeState.versions.set(key, version);
  const event: RefreshWebSocketEvent = {
    type: 'refresh',
    entityType: input.entityType,
    id: input.id,
    updatedAt: input.updatedAt || new Date().toISOString(),
    version,
    userId: input.userId,
    ...(input.deleted ? { deleted: true } : {}),
    ...(input.patch === undefined ? {} : { patch: input.patch }),
  };
  const previous = runtimeState.publishQueues.get(key) || Promise.resolve();
  const delivery = previous.catch(() => undefined).then(() => publishToMainServer(event));
  runtimeState.publishQueues.set(key, delivery);
  const cleanup = () => {
    if (runtimeState.publishQueues.get(key) === delivery) runtimeState.publishQueues.delete(key);
  };
  void delivery.then(cleanup, cleanup);
  return delivery;
}
