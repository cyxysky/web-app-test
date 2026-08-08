import { NextRequest } from 'next/server';
import { enqueueAutomationCaseRun } from '@/server/automation/automation-runner';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ caseId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { caseId } = await context.params;
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ caseId }),
      scope: 'automation_run.enqueue',
      userId,
    }, () => apiJson(request, {
      ok: true,
      run: enqueueAutomationCaseRun({ caseId, userId, trigger: 'manual' }),
    }, { status: 202 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return apiError(request, /not found/i.test(message)
      ? new ApiRequestError('自动化用例不存在', { code: 'not_found', status: 404 })
      : error, { fallback: '启动自动化运行失败' });
  }
}
