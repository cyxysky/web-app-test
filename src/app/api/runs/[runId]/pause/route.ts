import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const stepIndex = typeof body.stepIndex === 'number' ? body.stepIndex : undefined;
  const run = store.requestRunPause(runId, stepIndex);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, aborted: false, run });
}
