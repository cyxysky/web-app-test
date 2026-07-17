import { NextResponse } from 'next/server';
import { generateTaskFrame } from '@/server/ai/agents/task-frame-generator.agent';
import { withModelSettings, type ModelSettingsOverride } from '@/server/ai/model';
import { store } from '@/server/db/store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function modelSettingsFromBody(body: Record<string, unknown>): ModelSettingsOverride | undefined {
  const provider = typeof body.modelProvider === 'string' ? body.modelProvider : undefined;
  const model = typeof body.model === 'string' ? body.model : undefined;
  return provider || model ? { provider, model } : undefined;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const testCase = store.getTestCase(id);
  if (!testCase) {
    return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const userRequirement = String(body.userRequirement || testCase.content.userRequirement || testCase.description || '');
  const systemPrompt = String(body.systemPrompt || testCase.content.systemPrompt || '');
  const targetUrl = String(body.targetUrl || testCase.targetUrl || '');
  const modelSettings = modelSettingsFromBody(body);

  if (!userRequirement.trim()) {
    return NextResponse.json({ error: 'User requirement is required' }, { status: 400 });
  }

  const generate = () => generateTaskFrame({ userRequirement, systemPrompt, targetUrl });
  const taskFrame = modelSettings ? await withModelSettings(modelSettings, generate) : await generate();
  return NextResponse.json({ taskFrame });
}
