import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

export async function GET() {
  return NextResponse.json({ items: store.listGroups() });
}

export async function POST(request: Request) {
  const body = await request.json();
  const name = String(body.name || '').trim();
  const parentId = body.parentId ? String(body.parentId) : undefined;

  if (!name) return NextResponse.json({ error: 'Group name is required' }, { status: 400 });

  const group = store.createGroup(name, parentId);
  return NextResponse.json({ group });
}
