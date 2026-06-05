import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function isActiveRun(status: TestRunRecord['status']) {
  return status === 'running' || status === 'queued' || status === 'paused';
}

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (isActiveRun(run.status)) {
    return NextResponse.json({ error: '运行中的记录不能删除，请先结束或等待完成' }, { status: 400 });
  }
  store.deleteRun(runId);
  return NextResponse.json({ ok: true });
}
