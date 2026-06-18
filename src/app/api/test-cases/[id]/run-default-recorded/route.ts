import { NextResponse } from 'next/server';
import { startDefaultRecordedRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const run = startDefaultRecordedRun(id);
    return NextResponse.json({ runId: run?.id, status: run?.status, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '按默认记录执行失败' },
      { status: 500 },
    );
  }
}
