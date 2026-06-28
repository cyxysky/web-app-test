import { NextRequest, NextResponse } from 'next/server';
import { startBatchRun } from '@/server/ai/agents/test-runner.service';

function modelSettingsFromBody(body: Record<string, unknown>) {
  const provider = typeof body.modelProvider === 'string' ? body.modelProvider : undefined;
  const model = typeof body.model === 'string' ? body.model : undefined;
  return provider || model ? { provider, model } : undefined;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const testCaseIds = Array.isArray(body.testCaseIds) ? body.testCaseIds.filter(Boolean) : [];
    if (!testCaseIds.length) {
      return NextResponse.json({ error: '请选择至少一个测试用例' }, { status: 400 });
    }
    const runs = startBatchRun(testCaseIds, 'batch', modelSettingsFromBody(body));
    return NextResponse.json({ ok: true, runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '批量运行启动失败' },
      { status: 500 },
    );
  }
}
