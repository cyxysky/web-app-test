import { NextResponse } from 'next/server';
import { store } from '@/server/db/sqlite-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ items: await store.listTestCases() });
}
