import { NextResponse } from 'next/server';
import { store } from '@/server/db/sqlite-store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json();
  const groupId = body.groupId ? String(body.groupId) : undefined;
  const testCase = await store.moveTestCase(id, groupId);

  if (!testCase) return NextResponse.json({ error: 'Test case not found' }, { status: 404 });

  return NextResponse.json({ testCase });
}
