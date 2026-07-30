import { NextRequest, NextResponse } from 'next/server';
import { parseSkillContent, type SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { store } from '@/server/db/store';

type RouteContext = {
  params: Promise<{ skillId: string }>;
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeStatus(value: unknown): SkillRecord['status'] {
  const status = String(value || 'ready');
  return status === 'draft' || status === 'ready' || status === 'disabled' ? status as SkillRecord['status'] : 'ready';
}

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  return String(
    body?.userId
    ?? body?.qzUserId
    ?? request.nextUrl.searchParams.get('userId')
    ?? request.nextUrl.searchParams.get('qzUserId')
    ?? '',
  ).trim() || '0';
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  const skill = store.getSkill(skillId, requestUserId(request));
  if (!skill) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  try {
    const body = await request.json();
    const userId = requestUserId(request, body);
    const current = store.getSkill(skillId, userId);
    if (!current) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    if (current.userId !== userId) return NextResponse.json({ error: 'Only the Skill creator can edit this shared Skill' }, { status: 403 });
    const content = parseSkillContent(body.content);
    const skill = store.upsertSkill({
      id: skillId,
      title: String(body.title || ''),
      description: String(body.description || ''),
      domains: Array.isArray(body.domains) ? body.domains.map(String) : [],
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      content,
      sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
      status: normalizeStatus(body.status),
      shared: typeof body.shared === 'boolean' ? body.shared : undefined,
      userId,
    });
    return NextResponse.json({ skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid skill' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  const userId = requestUserId(request);
  const current = store.getSkill(skillId, userId);
  if (current && current.userId !== userId) return NextResponse.json({ error: 'Only the Skill creator can delete this shared Skill' }, { status: 403 });
  const deleted = store.deleteSkill(skillId, userId);
  if (!deleted) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
