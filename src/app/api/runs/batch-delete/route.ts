import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';
import { abortRunStep } from '@/server/ai/run-control.registry';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';

function refreshTestCaseStatusAfterRunDelete(testCaseId: string) {
  const remaining = store.listRunsForTestCase(testCaseId);
  const active = remaining.find((run) => run.status === 'running' || run.status === 'queued' || run.status === 'paused');
  if (active) {
    store.updateTestCaseStatus(testCaseId, 'running');
    return;
  }
  const latest = remaining[0];
  const finishedStatus = latest?.status === 'passed' || latest?.status === 'failed' || latest?.status === 'blocked'
    ? latest.status
    : 'ready';
  store.updateTestCaseStatus(testCaseId, finishedStatus);
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
  const affectedTestCaseIds = Array.from(new Set(existingRuns.map((run) => run.testCaseId)));
  existingRuns.forEach((run) => abortRunStep(run.id));

  const deleted = store.deleteRuns(runIds);
  affectedTestCaseIds.forEach(refreshTestCaseStatusAfterRunDelete);
  return NextResponse.json({ ok: true, deleted });
}
