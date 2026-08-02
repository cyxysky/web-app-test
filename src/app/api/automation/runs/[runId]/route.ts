import { NextRequest } from 'next/server';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { cancelAutomationRun, executeAutomationRun } from '@/server/automation/automation-runner';
import { noStoreJson } from '@/server/http/no-store-response';
import { getAutomationRun } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function requestUserId(request: NextRequest) {
  return normalizeApplicationUserId(
    request.nextUrl.searchParams.get('userId')
    ?? request.nextUrl.searchParams.get('qzUserId'),
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { runId } = await context.params;
  const run = getAutomationRun(runId, requestUserId(request));
  if (!run) return noStoreJson({ error: 'Automation run not found.' }, { status: 404 });
  return noStoreJson({ run });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { runId } = await context.params;
  const userId = requestUserId(request);
  const run = getAutomationRun(runId, userId);
  if (!run) return noStoreJson({ error: 'Automation run not found.' }, { status: 404 });
  if (run.status !== 'queued' && run.status !== 'running') {
    return noStoreJson({
      error: `Automation run already ended with ${run.status} and cannot be started.`,
      run,
    }, { status: 409 });
  }
  void executeAutomationRun(run.id, { userId: run.userId }).catch((error: unknown) => {
    console.warn(`[automation-api] Failed to execute run ${run.id}.`, error);
  });
  return noStoreJson({ ok: true, run }, { status: 202 });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { runId } = await context.params;
  const result = cancelAutomationRun(runId, requestUserId(request));
  if (!result) return noStoreJson({ error: 'Automation run not found.' }, { status: 404 });
  if (!result.accepted) {
    return noStoreJson({
      error: `Automation run already ended with ${result.run.status} and cannot be cancelled.`,
      run: result.run,
    }, { status: 409 });
  }
  return noStoreJson({ run: result.run, changed: result.changed });
}
