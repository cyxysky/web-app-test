import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

export async function GET() {
  return NextResponse.json({ items: store.listTestCases() });
}
