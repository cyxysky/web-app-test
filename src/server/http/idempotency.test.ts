import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('idempotency keys replay successful JSON and reject a different request', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-idempotency-'));
  process.env.APP_DATA_DIR = dataRoot;
  const { ApiRequestError } = await import('./api-request');
  const { idempotencyFingerprint, runIdempotentJson } = await import('./idempotency');
  const { getSqliteDatabase } = await import('../storage/sqlite-database');
  const { flushSqliteWriteQueue } = await import('../storage/sqlite-write-queue');
  const request = new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'request-key-0001' },
  });
  let executions = 0;
  const operation = () => {
    executions += 1;
    return new Response(JSON.stringify({ created: executions }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const fingerprint = idempotencyFingerprint({ value: 1 });
    const first = await runIdempotentJson(request, { fingerprint, scope: 'test.create', userId: 'test-user' }, operation);
    const replay = await runIdempotentJson(request, { fingerprint, scope: 'test.create', userId: 'test-user' }, operation);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('x-idempotency-replayed'), '1');
    assert.deepEqual(await replay.json(), { created: 1 });
    assert.equal(executions, 1);

    await assert.rejects(
      () => runIdempotentJson(request, {
        fingerprint: idempotencyFingerprint({ value: 2 }),
        scope: 'test.create',
        userId: 'test-user',
      }, operation),
      (error: unknown) => error instanceof ApiRequestError && error.status === 409,
    );
  } finally {
    await flushSqliteWriteQueue();
    getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
