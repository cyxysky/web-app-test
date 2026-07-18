import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: '默认记录功能已移除。' },
    { status: 410 },
  );
}
