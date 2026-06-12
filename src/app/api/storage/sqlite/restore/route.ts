import { NextRequest, NextResponse } from 'next/server';
import { restoreDatabaseBackup } from '@/server/db/sqlite-store-engine';
import { storageHealthSnapshot } from '@/server/storage/prisma-desktop';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await restoreDatabaseBackup({
      name: typeof body.name === 'string' ? body.name : undefined,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      health: await storageHealthSnapshot(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to restore SQLite backup' },
      { status: 500 },
    );
  }
}
