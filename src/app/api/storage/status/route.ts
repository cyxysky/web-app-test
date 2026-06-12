import { NextResponse } from 'next/server';
import { storageHealthSnapshot } from '@/server/storage/prisma-desktop';

export async function GET() {
  try {
    return NextResponse.json(await storageHealthSnapshot());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to inspect storage status' },
      { status: 500 },
    );
  }
}
