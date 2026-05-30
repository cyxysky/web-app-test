import { NextResponse } from 'next/server';
import { continueTestCaseRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;

  try {
    const run = continueTestCaseRun(runId);
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to continue run' },
      { status: 404 },
    );
  }
}
