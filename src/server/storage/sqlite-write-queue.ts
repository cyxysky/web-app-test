import { Worker } from 'node:worker_threads';
import type { SQLInputValue } from 'node:sqlite';
import { getSqliteDatabase, runSqliteTransaction, sqliteDatabasePath } from './sqlite-database';
import { incrementMetric, recordMetricTiming, setMetricGauge, structuredLog } from '@/server/observability/runtime-observability';

export type SqliteWriteStatement = {
  params?: SQLInputValue[];
  sql: string;
};

type PendingWrite = {
  reject: (error: Error) => void;
  resolve: () => void;
  startedAt: number;
};

type WriteQueueState = {
  idleTimer?: ReturnType<typeof setTimeout>;
  idleWaiters: Set<() => void>;
  nextId: number;
  pending: Map<number, PendingWrite>;
  worker?: Worker;
};

const state: WriteQueueState = ((globalThis as typeof globalThis & {
  __sqliteWriteQueueState?: WriteQueueState;
}).__sqliteWriteQueueState ??= {
  idleWaiters: new Set(),
  nextId: 1,
  pending: new Map(),
} as WriteQueueState);
state.idleWaiters ??= new Set();

const workerSource = String.raw`
  const { parentPort } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  let database;
  let databasePath = '';
  function db(path) {
    if (database && databasePath === path) return database;
    if (database) database.close();
    database = new DatabaseSync(path);
    databasePath = path;
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    return database;
  }
  parentPort.on('message', (job) => {
    const current = db(job.databasePath);
    let result;
    try {
      current.exec('BEGIN IMMEDIATE');
      for (const statement of job.statements) {
        current.prepare(statement.sql).run(...(statement.params || []));
      }
      current.exec('COMMIT');
      result = { id: job.id, ok: true };
    } catch (error) {
      try { current.exec('ROLLBACK'); } catch {}
      result = { id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      try { current.close(); } catch {}
      database = undefined;
      databasePath = '';
    }
    parentPort.postMessage(result);
  });
`;

function updateQueueGauge() {
  setMetricGauge('sqlite_write_queue_depth', state.pending.size);
  if (!state.pending.size) {
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
    if (state.worker && !state.idleTimer) {
      state.idleTimer = setTimeout(() => {
        state.idleTimer = undefined;
        if (state.pending.size || !state.worker) return;
        const current = state.worker;
        state.worker = undefined;
        void current.terminate();
      }, 250);
      state.idleTimer.unref?.();
    }
  }
}

function failPendingWrites(error: Error) {
  for (const pending of state.pending.values()) pending.reject(error);
  state.pending.clear();
  updateQueueGauge();
}

function worker() {
  if (state.worker) return state.worker;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  const next = new Worker(workerSource, { eval: true });
  next.unref();
  next.on('message', (message: { error?: string; id?: number; ok?: boolean }) => {
    const id = Number(message.id);
    const pending = state.pending.get(id);
    if (!pending) return;
    state.pending.delete(id);
    updateQueueGauge();
    recordMetricTiming('sqlite_worker_write_ms', performance.now() - pending.startedAt, {
      status: message.ok ? 'ok' : 'error',
    });
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error || 'SQLite worker write failed'));
  });
  next.on('error', (error) => {
    structuredLog({ event: 'sqlite.write_worker.error', level: 'error', error });
    failPendingWrites(error);
    state.worker = undefined;
  });
  next.on('exit', (code) => {
    if (state.worker === next) state.worker = undefined;
    if (code !== 0) failPendingWrites(new Error(`SQLite write worker exited with code ${code}`));
  });
  state.worker = next;
  return next;
}

function runOnMainThread(statements: SqliteWriteStatement[]) {
  runSqliteTransaction((database) => {
    for (const statement of statements) database.prepare(statement.sql).run(...(statement.params || []));
  });
}

export function queueSqliteWrite(statements: SqliteWriteStatement[]) {
  if (!statements.length) return Promise.resolve();
  getSqliteDatabase();
  if (process.env.SQLITE_WORKER_WRITES_ENABLED === 'false') {
    const startedAt = performance.now();
    try {
      runOnMainThread(statements);
      recordMetricTiming('sqlite_worker_write_ms', performance.now() - startedAt, { status: 'fallback' });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const configuredMaximumPending = Number(process.env.SQLITE_WRITE_QUEUE_MAX_PENDING || 2_000);
  const maximumPending = Number.isFinite(configuredMaximumPending)
    ? Math.max(16, Math.min(10_000, Math.floor(configuredMaximumPending)))
    : 2_000;
  if (state.pending.size >= maximumPending) {
    incrementMetric('sqlite_write_queue_rejected_total');
    return Promise.reject(new Error('SQLite write queue is full'));
  }
  const id = state.nextId++;
  const promise = new Promise<void>((resolve, reject) => {
    state.pending.set(id, { reject, resolve, startedAt: performance.now() });
  });
  updateQueueGauge();
  worker().postMessage({ databasePath: sqliteDatabasePath(), id, statements });
  return promise;
}

export async function flushSqliteWriteQueue() {
  while (state.pending.size) {
    await new Promise<void>((resolve) => state.idleWaiters.add(resolve));
  }
}

export function sqliteWriteQueueSnapshot() {
  return { pending: state.pending.size, workerActive: Boolean(state.worker) };
}
