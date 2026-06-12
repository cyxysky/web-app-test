import { NextRequest, NextResponse } from 'next/server';
import { startBatchRun } from '@/server/ai/agents/test-runner.service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const testCaseIds = Array.isArray(body.testCaseIds) ? body.testCaseIds.filter(Boolean) : [];
    if (!testCaseIds.length) {
      return NextResponse.json({ error: '请选择至少一个测试用例' }, { status: 400 });
    }
    const runs = await startBatchRun(testCaseIds);
    return NextResponse.json({ ok: true, runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '批量运行启动失败' },
      { status: 500 },
    );
  }
}
