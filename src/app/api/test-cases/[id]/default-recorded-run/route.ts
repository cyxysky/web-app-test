import { NextResponse } from 'next/server';
import { store } from '@/server/db/store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function runHasReplayableTools(runId: string) {
  const run = store.getRun(runId);
  return Boolean(run?.result?.steps.some((step) => step.tools?.some((tool) => tool.name && tool.ok !== false)));
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const testCase = store.getTestCase(id);
    if (!testCase) return NextResponse.json({ error: 'Test case not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : undefined;
    if (runId) {
      const run = store.getRun(runId);
      if (!run || run.testCaseId !== id) {
        return NextResponse.json({ error: '执行记录不存在或不属于当前测试用例' }, { status: 404 });
      }
      if (run.status === 'running' || run.status === 'queued' || run.status === 'paused') {
        return NextResponse.json({ error: '运行中的执行记录不能设为默认记录' }, { status: 400 });
      }
      if (!runHasReplayableTools(runId)) {
        return NextResponse.json({ error: '这条执行记录没有可回放的成功工具调用' }, { status: 400 });
      }
    }

    const updated = store.updateTestCase(id, {
      ...testCase.content,
      defaultRecordedRunId: runId,
    }, testCase.imageNames);

    return NextResponse.json({ ok: true, testCase: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '设置默认记录失败' },
      { status: 400 },
    );
  }
}
