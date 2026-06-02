import { NextResponse } from 'next/server';
import { replayRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;

  try {
    const run = replayRun(runId);
    return NextResponse.json({ ok: true, runId: run?.id, status: run?.status, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to replay run' },
      { status: 400 },
    );
  }
}
