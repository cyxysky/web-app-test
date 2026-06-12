import { NextResponse } from 'next/server';
import { store } from '@/server/db/sqlite-store';
import { abortRunStep } from '@/server/ai/run-control.registry';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

async function refreshTestCaseStatusAfterRunDelete(testCaseId: string) {
  const remaining = await store.listRunsForTestCase(testCaseId);
  const active = remaining.find((run) => run.status === 'running' || run.status === 'queued' || run.status === 'paused');
  if (active) {
    await store.updateTestCaseStatus(testCaseId, 'running');
    return;
  }
  const latest = remaining[0];
  const finishedStatus = latest?.status === 'passed' || latest?.status === 'failed' || latest?.status === 'blocked'
    ? latest.status
    : 'ready';
  await store.updateTestCaseStatus(testCaseId, finishedStatus);
}

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = await store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  abortRunStep(runId);
  await store.deleteRun(runId);
  await refreshTestCaseStatusAfterRunDelete(run.testCaseId);
  return NextResponse.json({ ok: true });
}
