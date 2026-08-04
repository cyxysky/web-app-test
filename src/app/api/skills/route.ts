import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/db/store';
import { parseSkillContent } from '@/server/ai/schemas/runtime.schema';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q') || undefined;
  const skills = store.listSkills(query, requestUserId(request));
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
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      content,
      sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
      status: ['draft', 'ready', 'disabled'].includes(String(body.status)) ? body.status : 'ready',
      shared: body.shared === true,
      userId: requestUserId(request),
    });
    return NextResponse.json({ skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid skill' },
      { status: 400 },
    );
  }
}
