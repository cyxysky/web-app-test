import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/db/store';
import { parseSkillContent } from '@/server/ai/schemas/test-case.schema';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q') || undefined;
  const skills = store.listSkills(query);
  return NextResponse.json({ skills });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const content = parseSkillContent(body.content);
    const skill = store.upsertSkill({
      id: typeof body.id === 'string' ? body.id : undefined,
      title: String(body.title || ''),
      description: String(body.description || ''),
      domains: Array.isArray(body.domains) ? body.domains.map(String) : [],
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      content,
      sourceRunId: typeof body.sourceRunId === 'string' ? body.sourceRunId : undefined,
      sourceTestCaseId: typeof body.sourceTestCaseId === 'string' ? body.sourceTestCaseId : undefined,
      sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
      status: ['draft', 'ready', 'disabled'].includes(String(body.status)) ? body.status : 'ready',
    });
    return NextResponse.json({ skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid skill' },
      { status: 400 },
    );
  }
}
