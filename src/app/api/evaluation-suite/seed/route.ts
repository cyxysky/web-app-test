import { NextResponse } from 'next/server';
import { seedMinimalEvaluationSuite } from '@/server/evaluation/evaluation-suite';

export async function POST() {
  try {
    return NextResponse.json({ ok: true, result: await seedMinimalEvaluationSuite() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '创建最小评测集失败' },
      { status: 500 },
    );
  }
}
