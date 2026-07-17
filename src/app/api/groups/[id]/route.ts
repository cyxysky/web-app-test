import { NextResponse } from 'next/server';
import { store } from '@/server/db/store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const result = store.deleteGroup(id);
  if (!result) return NextResponse.json({ error: 'Group not found' }, { status: 404 });
  return NextResponse.json(result);
}
