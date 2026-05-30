import { NextRequest, NextResponse } from 'next/server';
import { generateTestCase } from '@/server/ai/agents/test-case-generator.agent';
import { store } from '@/server/db/mock-store';
import { richTextToPlainText } from '@/lib/rich-text';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const prompt = String(body.prompt || '').trim();
  const targetUrl = body.targetUrl ? String(body.targetUrl) : undefined;
  const imageNames = Array.isArray(body.imageNames) ? body.imageNames.map(String) : [];
  const groupId = body.groupId ? String(body.groupId) : undefined;

  if (!richTextToPlainText(prompt)) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
  }

  const content = await generateTestCase({ prompt, targetUrl, imageNames });
  const testCase = store.createTestCase(content, imageNames, groupId);

  return NextResponse.json({ testCaseId: testCase.id, status: testCase.status, testCase });
}
