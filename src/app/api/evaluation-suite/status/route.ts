import { NextResponse } from 'next/server';
import { getEvaluationSuiteStatus } from '@/server/evaluation/evaluation-suite';

export async function GET() {
  try {
    return NextResponse.json({ status: await getEvaluationSuiteStatus() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load evaluation suite status' },
      { status: 500 },
    );
  }
}
