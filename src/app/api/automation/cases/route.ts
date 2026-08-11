import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, boundedQueryInteger, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { createAutomationCase, listAutomationCases } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const createCaseSchema = z.object({
  title: z.union([z.string(), z.number()]).optional(),
  name: z.union([z.string(), z.number()]).optional(),
  instruction: z.union([z.string(), z.number()]).optional(),
  prompt: z.union([z.string(), z.number()]).optional(),
  description: z.union([z.string(), z.number()]).optional(),
  targetUrl: z.union([z.string(), z.number()]).optional(),
  url: z.union([z.string(), z.number()]).optional(),
}).strict();

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export async function GET(request: NextRequest) {
  const limit = boundedQueryInteger(request.nextUrl.searchParams.get('limit'), { fallback: 10, max: 100 });
  const records = listAutomationCases({
    userId: requestApplicationUserId(request),
    sourceSessionId: request.nextUrl.searchParams.get('sourceSessionId')?.trim() || undefined,
    beforeId: request.nextUrl.searchParams.get('beforeId')?.trim() || undefined,
    beforeUpdatedAt: request.nextUrl.searchParams.get('beforeUpdatedAt')?.trim() || undefined,
    limit: limit + 1,
  });
  const cases = records.slice(0, limit);
  const last = cases.at(-1);
  return apiJson(request, {
    cases,
    page: {
      hasMore: records.length > limit,
      next: records.length > limit && last
        ? { beforeId: last.id, beforeUpdatedAt: last.updatedAt }
        : undefined,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, createCaseSchema, { maxBytes: 64 * 1024 });
    const title = text(body.title ?? body.name);
    const instruction = text(body.instruction ?? body.prompt);
    if (!title) throw new ApiRequestError('自动化用例标题不能为空', { code: 'title_required' });
    if (!instruction) throw new ApiRequestError('自动化用例指令不能为空', { code: 'instruction_required' });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'automation_case.create',
      userId,
    }, () => {
      const automationCase = createAutomationCase({
        userId,
        title,
        description: text(body.description) || undefined,
        sourceSessionId: 'manual',
        sourceMessageIds: [],
        targetUrl: text(body.targetUrl ?? body.url) || 'about:blank',
        instruction,
        mode: 'code',
        operations: [],
      });
      return apiJson(request, {
        ok: true,
        case: automationCase,
        automationCase,
        cases: listAutomationCases({ userId, limit: 10 }),
      }, { status: 201 });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '创建自动化用例失败' });
  }
}
