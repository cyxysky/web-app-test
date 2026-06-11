import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';
import { abortRunStep } from '@/server/ai/run-control.registry';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

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

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  abortRunStep(runId);
  store.deleteRun(runId);
  refreshTestCaseStatusAfterRunDelete(run.testCaseId);
  return NextResponse.json({ ok: true });
}
