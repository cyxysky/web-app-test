import { NextResponse } from 'next/server';
import { getRecordedFlowForRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  try {
    const flow = await getRecordedFlowForRun(runId);
    return NextResponse.json({ flow });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '录制流程不存在' },
      { status: 404 },
    );
  }
}
