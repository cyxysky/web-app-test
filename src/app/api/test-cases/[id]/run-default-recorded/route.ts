import { NextResponse } from 'next/server';
import { startDefaultRecordedRun } from '@/server/ai/agents/test-runner.service';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function modelSettingsFromBody(body: Record<string, unknown>) {
  const provider = typeof body.modelProvider === 'string' ? body.modelProvider : undefined;
  const model = typeof body.model === 'string' ? body.model : undefined;
  return provider || model ? { provider, model } : undefined;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const run = startDefaultRecordedRun(id, modelSettingsFromBody(body));
    return NextResponse.json({ runId: run?.id, status: run?.status, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '按默认记录执行失败' },
      { status: 500 },
    );
  }
}
