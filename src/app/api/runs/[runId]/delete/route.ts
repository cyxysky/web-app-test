import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = store.getRun(runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (run.status === 'running' || run.status === 'queued' || run.status === 'paused') {
    return NextResponse.json({ error: '运行中记录不能删除，请先结束或等待完成' }, { status: 400 });
  }
  store.deleteRun(runId);
  return NextResponse.json({ ok: true });
}
