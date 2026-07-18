import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: '默认记录执行功能已移除，请使用普通测试执行。' },
    { status: 410 },
  );
}
