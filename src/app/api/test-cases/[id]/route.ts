import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';
import { testCaseContentSchema } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const testCase = store.getTestCase(id);

  if (!testCase) {
    return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  return NextResponse.json(testCase);
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const userRequirement = String(body.userRequirement || body.description || '');
    const plainRequirement = richTextToPlainText(userRequirement) || richTextToPlainText(String(body.description || ''));
    const parsed = testCaseContentSchema.parse({
      ...body,
      description: plainRequirement,
      userRequirement,
      steps: (body.steps || []).map((step: unknown, index: number) => ({ ...(step as object), index: index + 1 })),
    });
    const updated = store.updateTestCase(id, parsed, body.imageNames);

    if (!updated) {
      return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid test case' }, { status: 400 });
  }
}
