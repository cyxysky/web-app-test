import { executeDatabase, runDatabaseTransaction } from '@/server/db/database';
import { incrementMetric, recordMetricTiming, setMetricGauge } from '@/server/observability/runtime-observability';

export type DatabaseWriteStatement = {
  params?: unknown[];
  sql: string;
};

type PendingWrite = {
  statements: DatabaseWriteStatement[];
  reject: (error: unknown) => void;
  resolve: () => void;
  startedAt: number;
};

type DatabaseWriteQueueState = {
  draining?: Promise<void>;
  idleWaiters: Set<() => void>;
  pending: PendingWrite[];
};

const state = ((globalThis as typeof globalThis & {
  __databaseWriteQueueState?: DatabaseWriteQueueState;
}).__databaseWriteQueueState ??= {
  idleWaiters: new Set(),
  pending: [],
});

function updateQueueGauge() {
  setMetricGauge('database_write_queue_depth', state.pending.length);
  if (!state.pending.length && !state.draining) {
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
  }
}

async function drainQueue() {
  while (state.pending.length) {
    const pending = state.pending.shift()!;
    updateQueueGauge();
    try {
      await runDatabaseTransaction(async (manager) => {
        for (const statement of pending.statements) {
          await executeDatabase(statement.sql, statement.params || [], manager);
        }
      });
      recordMetricTiming('database_write_ms', performance.now() - pending.startedAt, { status: 'ok' });
      pending.resolve();
    } catch (error) {
      recordMetricTiming('database_write_ms', performance.now() - pending.startedAt, { status: 'error' });
      pending.reject(error);
    }
  }
}

export function queueDatabaseWrite(statements: DatabaseWriteStatement[]) {
  if (!statements.length) return Promise.resolve();
  const configuredMaximumPending = Number(process.env.DATABASE_WRITE_QUEUE_MAX_PENDING || 2_000);
  const maximumPending = Number.isFinite(configuredMaximumPending)
    ? Math.max(16, Math.min(10_000, Math.floor(configuredMaximumPending)))
    : 2_000;
  if (state.pending.length >= maximumPending) {
    incrementMetric('database_write_queue_rejected_total');
    return Promise.reject(new Error('Database write queue is full'));
  }
  const promise = new Promise<void>((resolve, reject) => {
    state.pending.push({ statements, reject, resolve, startedAt: performance.now() });
  });
  updateQueueGauge();
  if (!state.draining) {
    state.draining = drainQueue().finally(() => {
      state.draining = undefined;
      updateQueueGauge();
    });
  }
  return promise;
}

export async function flushDatabaseWriteQueue() {
  if (state.draining) await state.draining;
  while (state.pending.length) {
    await new Promise<void>((resolve) => state.idleWaiters.add(resolve));
  }
}

export async function closeDatabaseWriteQueue() {
  await flushDatabaseWriteQueue();
}

export function databaseWriteQueueSnapshot() {
  return { pending: state.pending.length, workerActive: Boolean(state.draining) };
}
