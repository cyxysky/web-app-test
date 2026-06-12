import { NextRequest, NextResponse } from 'next/server';
import { importRuntimeData } from '@/server/db/sqlite-store-engine';
import { storageHealthSnapshot } from '@/server/storage/prisma-desktop';

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const result = await importRuntimeData(payload);
    return NextResponse.json({
      ok: true,
      ...result,
      health: await storageHealthSnapshot(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to import SQLite runtime data' },
      { status: 400 },
    );
  }
}
