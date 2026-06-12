import { NextRequest, NextResponse } from 'next/server';
import { startScheduler } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/sqlite-store';

export async function GET() {
  startScheduler();
  return NextResponse.json({ schedules: await store.listSchedules() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const intervalMinutes = Number(body.intervalMinutes || 60);
    const schedule = await store.upsertSchedule({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: typeof body.name === 'string' ? body.name : '定时回归',
      enabled: body.enabled !== false,
      testCaseIds: Array.isArray(body.testCaseIds) ? body.testCaseIds.filter(Boolean) : [],
      intervalMinutes,
      nextRunAt: typeof body.nextRunAt === 'string' && body.nextRunAt ? body.nextRunAt : undefined,
    });
    startScheduler();
    return NextResponse.json({ ok: true, schedule, schedules: await store.listSchedules() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存定时任务失败' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少任务 ID' }, { status: 400 });
  await store.deleteSchedule(id);
  return NextResponse.json({ ok: true, schedules: await store.listSchedules() });
}
