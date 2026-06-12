import { NextRequest, NextResponse } from 'next/server';
import { createDatabaseBackup } from '@/server/db/sqlite-store-engine';
import { storageHealthSnapshot } from '@/server/storage/prisma-desktop';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const backup = await createDatabaseBackup({
      name: typeof body.name === 'string' ? body.name : undefined,
    });
    return NextResponse.json({
      ok: true,
      backup,
      health: await storageHealthSnapshot(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create SQLite backup' },
      { status: 500 },
    );
  }
}
