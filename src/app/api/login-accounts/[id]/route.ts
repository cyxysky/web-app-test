import { NextRequest } from 'next/server';
import { z } from 'zod';
import { deleteLoginAccount, getLoginAccountById, updateLoginAccount } from '@/server/credentials/login-account-vault';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  domain: z.string().trim().min(1).max(1_000).optional(),
  username: z.string().trim().min(1).max(500).optional(),
  password: z.string().max(4_000).optional(),
  label: z.string().trim().max(500).optional(),
  loginUrl: z.string().trim().max(4_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  shared: z.boolean().optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), {
  message: '没有可更新的账号字段',
});

function accountError(error: unknown) {
  if (error instanceof ApiRequestError) return error;
  const message = error instanceof Error ? error.message : '登录账号操作失败';
  return new ApiRequestError(message, {
    code: /已存在|already exists/i.test(message) ? 'account_already_exists' : 'account_operation_failed',
    status: /已存在|already exists/i.test(message) ? 409 : 400,
  });
}

function editableAccount(id: string, userId: string) {
  const account = getLoginAccountById(id, userId);
  if (!account) throw new ApiRequestError('登录账号不存在', { code: 'not_found', status: 404 });
  if (account.userId !== userId) {
    throw new ApiRequestError('只有账号创建者可以修改或删除共享账号', { code: 'forbidden', status: 403 });
  }
  return account;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJsonRequest(request, updateSchema, { maxBytes: 16 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ id, ...body }),
      scope: 'login_account.update',
      userId,
    }, () => {
      editableAccount(id, userId);
      const account = updateLoginAccount(id, body, userId);
      if (!account) throw new ApiRequestError('登录账号不存在', { code: 'not_found', status: 404 });
      return apiJson(request, { account });
    });
  } catch (error) {
    return apiError(request, accountError(error), { fallback: '更新登录账号失败' });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ id }),
      scope: 'login_account.delete',
      userId,
    }, () => {
      editableAccount(id, userId);
      if (!deleteLoginAccount(id, userId)) {
        throw new ApiRequestError('登录账号不存在', { code: 'not_found', status: 404 });
      }
      return apiJson(request, { ok: true });
    });
  } catch (error) {
    return apiError(request, accountError(error), { fallback: '删除登录账号失败' });
  }
}
