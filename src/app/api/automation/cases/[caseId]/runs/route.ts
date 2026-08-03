import { NextRequest } from 'next/server';
import { enqueueAutomationCaseRun } from '@/server/automation/automation-runner';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ caseId: string }>;
};

type RequestBody = Record<string, unknown>;

function requestUserId(request: NextRequest, _body: RequestBody) {
  return requestApplicationUserId(request, _body);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { caseId } = await context.params;
  try {
    const parsed = await request.json().catch(() => ({}));
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RequestBody
      : {};
    const run = enqueueAutomationCaseRun({
      caseId,
      userId: requestUserId(request, body),
      trigger: 'manual',
    });
    return noStoreJson({ ok: true, run }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start automation run.';
    return noStoreJson(
      { error: message },
      { status: /not found/i.test(message) ? 404 : 400 },
    );
  }
}
