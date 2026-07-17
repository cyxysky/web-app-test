import { NextResponse } from 'next/server';
import { store } from '@/server/db/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ items: store.listTestCases() });
}
