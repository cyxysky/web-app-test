import { NextRequest, NextResponse } from 'next/server';
import { startTestCaseRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;

  try {
    const run = startTestCaseRun(id);
    return NextResponse.json({ runId: run?.id, status: run?.status, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to run test case' },
      { status: 500 },
    );
  }
}
