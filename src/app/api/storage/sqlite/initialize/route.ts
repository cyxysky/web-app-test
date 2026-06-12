import { NextResponse } from 'next/server';
import { initializeSqliteDatabase } from '@/server/storage/prisma-desktop';

export async function POST() {
  try {
    return NextResponse.json(await initializeSqliteDatabase());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to initialize SQLite database' },
      { status: 500 },
    );
  }
}
