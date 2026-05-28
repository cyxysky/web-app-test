import { NextRequest, NextResponse } from 'next/server';
import { generateTestCase } from '@/server/ai/agents/test-case-generator.agent';
import { store } from '@/server/db/mock-store';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const prompt = String(body.prompt || '').trim();
  const targetUrl = body.targetUrl ? String(body.targetUrl) : undefined;
  const imageNames = Array.isArray(body.imageNames) ? body.imageNames.map(String) : [];

  if (!prompt) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
  }

  const content = await generateTestCase({ prompt, targetUrl, imageNames });
  const testCase = store.createTestCase(content, imageNames);

  return NextResponse.json({ testCaseId: testCase.id, status: testCase.status, testCase });
}
