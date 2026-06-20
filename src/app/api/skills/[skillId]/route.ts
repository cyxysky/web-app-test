import { NextRequest, NextResponse } from 'next/server';
import { skillContentSchema, type SkillRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ skillId: string }>;
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeStatus(value: unknown): SkillRecord['status'] {
  const status = String(value || 'ready');
  return status === 'draft' || status === 'ready' || status === 'disabled' ? status as SkillRecord['status'] : 'ready';
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  const skill = store.getSkill(skillId);
  if (!skill) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  if (!store.getSkill(skillId)) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });

  try {
    const body = await request.json();
    const content = skillContentSchema.parse(body.content || {});
    const skill = store.upsertSkill({
      id: skillId,
      title: String(body.title || ''),
      description: String(body.description || ''),
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      content,
      sourceRunId: typeof body.sourceRunId === 'string' ? body.sourceRunId : undefined,
      sourceTestCaseId: typeof body.sourceTestCaseId === 'string' ? body.sourceTestCaseId : undefined,
      sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
      status: normalizeStatus(body.status),
    });
    return NextResponse.json({ skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid skill' },
      { status: 400 },
    );
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  const deleted = store.deleteSkill(skillId);
  if (!deleted) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
