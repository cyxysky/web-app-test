import { NextResponse } from 'next/server';
import { generateSkillFromRun } from '@/server/ai/agents/skill-generator.agent';
import { store } from '@/server/db/store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  try {
    const run = store.getRun(runId);
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    const testCase = store.getTestCase(run.testCaseId);
    if (!testCase) return NextResponse.json({ error: 'Test case not found' }, { status: 404 });

    const generated = await generateSkillFromRun({ run, testCase });
    const skill = store.upsertSkill({
      ...generated,
      status: 'ready',
    });
    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate skill' },
      { status: 400 },
    );
  }
}
