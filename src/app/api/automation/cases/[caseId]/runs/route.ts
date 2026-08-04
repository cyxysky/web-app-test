import { NextRequest } from 'next/server';
import { enqueueAutomationCaseRun } from '@/server/automation/automation-runner';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ caseId: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { caseId } = await context.params;
  try {
    const run = enqueueAutomationCaseRun({
      caseId,
      userId: requestUserId(request),
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
