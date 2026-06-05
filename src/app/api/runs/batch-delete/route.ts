import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';

function isActiveRun(status: TestRunRecord['status']) {
  return status === 'running' || status === 'queued' || status === 'paused';
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { runIds?: unknown };
  const rawRunIds = Array.isArray(body.runIds) ? body.runIds : [];
  const runIds = Array.from(
    new Set(
      rawRunIds
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );

  if (!runIds.length) {
    return NextResponse.json({ error: '请选择要删除的执行记录' }, { status: 400 });
  }

  const existingRuns = runIds.map((runId) => store.getRun(runId)).filter((run): run is TestRunRecord => Boolean(run));
  const activeRuns = existingRuns.filter((run) => isActiveRun(run.status));
  if (activeRuns.length) {
    return NextResponse.json(
      { error: '运行中、排队中或暂停中的记录不能删除', blockedRunIds: activeRuns.map((run) => run.id) },
      { status: 400 },
    );
  }

  const deleted = store.deleteRuns(runIds);
  return NextResponse.json({ ok: true, deleted });
}
