import { NextRequest } from 'next/server';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { deleteAutomationCase, getAutomationCase, updateAutomationCase } from '@/server/storage/automation-store';
import { automationTaskUpdateSchema } from '@/server/automation/automation.schema';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ caseId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { caseId } = await context.params;
    const automationCase = await getAutomationCase(caseId, requestApplicationUserId(request));
    if (!automationCase) throw new ApiRequestError('自动化用例不存在', { code: 'not_found', status: 404 });
    if (request.nextUrl.searchParams.get('download') === '1') {
      return apiJson(request, automationCase, {
        headers: { 'Content-Disposition': `attachment; filename="automation-case-${automationCase.id}.json"` },
      });
    }
    return apiJson(request, { case: automationCase, automationCase });
  } catch (error) {
    return apiError(request, error, { fallback: '读取自动化用例失败' });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { caseId } = await context.params;
    const userId = requestApplicationUserId(request);
    const patch = await parseJsonRequest(request, automationTaskUpdateSchema, { maxBytes: 1024 * 1024 });
    const automationCase = await updateAutomationCase(caseId, userId, patch);
    if (!automationCase) throw new ApiRequestError('自动化任务不存在', { code: 'not_found', status: 404 });
    return apiJson(request, { ok: true, case: automationCase, automationCase });
  } catch (error) {
    return apiError(request, error, { fallback: '保存自动化任务失败' });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { caseId } = await context.params;
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ caseId }),
      scope: 'automation_case.delete',
      userId,
    }, async () => {
      const automationCase = await getAutomationCase(caseId, userId);
      if (!automationCase || !await deleteAutomationCase(caseId, userId)) {
        throw new ApiRequestError('自动化用例不存在', { code: 'not_found', status: 404 });
      }
      return apiJson(request, { ok: true, deleted: { id: automationCase.id }, case: automationCase, automationCase });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '删除自动化用例失败' });
  }
}
