import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ items: await store.listTestCases() });
}
