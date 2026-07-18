import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: '记录重放功能已移除，请重新执行测试。' },
    { status: 410 },
  );
}
