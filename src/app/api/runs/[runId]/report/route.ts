import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = await store.getRun(runId);

  if (!run?.report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }

  return NextResponse.json(run.report);
}
