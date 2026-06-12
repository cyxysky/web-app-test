import { NextResponse } from 'next/server';
import { generateTaskFrame } from '@/server/ai/agents/task-frame-generator.agent';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const testCase = await store.getTestCase(id);
  if (!testCase) {
    return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const userRequirement = String(body.userRequirement || testCase.content.userRequirement || testCase.description || '');
  const systemPrompt = String(body.systemPrompt || testCase.content.systemPrompt || '');
  const targetUrl = String(body.targetUrl || testCase.targetUrl || '');

  if (!userRequirement.trim()) {
    return NextResponse.json({ error: 'User requirement is required' }, { status: 400 });
  }

  const taskFrame = await generateTaskFrame({ userRequirement, systemPrompt, targetUrl });
  return NextResponse.json({ taskFrame });
}
