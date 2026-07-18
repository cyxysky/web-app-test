import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: '录制流转用例功能已移除。' },
    { status: 410 },
  );
}
