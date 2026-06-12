import { NextResponse } from 'next/server';
import { createTestCaseFromRecordedRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  try {
    const testCase = await createTestCaseFromRecordedRun(runId);
    return NextResponse.json({ ok: true, testCase });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '录制转用例失败' },
      { status: 400 },
    );
  }
}
