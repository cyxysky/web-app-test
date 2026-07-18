import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    { error: '录制流功能已移除。' },
    { status: 410 },
  );
}
