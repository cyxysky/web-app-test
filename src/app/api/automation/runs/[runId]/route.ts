import { NextRequest } from 'next/server';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { cancelAutomationRun, executeAutomationRun } from '@/server/automation/automation-runner';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { structuredLog } from '@/server/observability/runtime-observability';
import { getAutomationRun } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const run = getAutomationRun(runId, requestApplicationUserId(request));
    if (!run) throw new ApiRequestError('自动化运行不存在', { code: 'not_found', status: 404 });
    return apiJson(request, { run });
  } catch (error) {
    return apiError(request, error, { fallback: '读取自动化运行失败' });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ runId }),
      scope: 'automation_run.start',
      userId,
    }, () => {
      const run = getAutomationRun(runId, userId);
      if (!run) throw new ApiRequestError('自动化运行不存在', { code: 'not_found', status: 404 });
      if (run.status !== 'queued' && run.status !== 'running') {
        throw new ApiRequestError(`自动化运行已以 ${run.status} 状态结束，无法再次启动`, {
          code: 'run_already_finished',
          status: 409,
        });
      }
      void executeAutomationRun(run.id, { userId: run.userId }).catch((error: unknown) => {
        structuredLog({ event: 'automation.run_execution_failed', level: 'error', runId: run.id, error });
      });
      return apiJson(request, { ok: true, run }, { status: 202 });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '启动自动化运行失败' });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ runId }),
      scope: 'automation_run.cancel',
      userId,
    }, () => {
      const result = cancelAutomationRun(runId, userId);
      if (!result) throw new ApiRequestError('自动化运行不存在', { code: 'not_found', status: 404 });
      if (!result.accepted) {
        throw new ApiRequestError(`自动化运行已以 ${result.run.status} 状态结束，无法取消`, {
          code: 'run_already_finished',
          status: 409,
        });
      }
      return apiJson(request, { run: result.run, changed: result.changed });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '取消自动化运行失败' });
  }
}
