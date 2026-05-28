import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const testCase = store.getTestCase(id);

  if (!testCase) {
    return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  return NextResponse.json(testCase);
}
