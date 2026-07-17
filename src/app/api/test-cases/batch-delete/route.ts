import { NextResponse } from 'next/server';
import { store } from '@/server/db/store';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { testCaseIds?: unknown };
  const rawIds = Array.isArray(body.testCaseIds) ? body.testCaseIds : [];
  const testCaseIds = Array.from(
    new Set(
      rawIds
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );

  if (!testCaseIds.length) {
    return NextResponse.json({ error: '请选择要删除的测试用例' }, { status: 400 });
  }

  let deleted = 0;
  for (const testCaseId of testCaseIds) {
    if (store.deleteTestCase(testCaseId)) deleted += 1;
  }

  return NextResponse.json({ ok: true, deleted });
}
