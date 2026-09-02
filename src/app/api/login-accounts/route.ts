import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLoginAccount, listLoginAccounts } from '@/server/credentials/login-account-vault';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const createSchema = z.object({
  domain: z.string().trim().min(1).max(1_000),
  username: z.string().trim().min(1).max(500),
  password: z.string().min(1).max(4_000),
  label: z.string().trim().max(500).optional(),
  loginUrl: z.string().trim().max(4_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  shared: z.boolean().optional(),
}).strict();

function accountError(error: unknown) {
  if (error instanceof ApiRequestError) return error;
  const message = error instanceof Error ? error.message : '登录账号操作失败';
  return new ApiRequestError(message, {
    code: /已存在|already exists/i.test(message) ? 'account_already_exists' : 'account_operation_failed',
    status: /已存在|already exists/i.test(message) ? 409 : 400,
  });
}

export async function GET(request: NextRequest) {
  try {
    return apiJson(request, {
      accounts: await listLoginAccounts({
        userId: requestApplicationUserId(request),
        domain: request.nextUrl.searchParams.get('domain') || '',
      }),
    });
  } catch (error) {
    return apiError(request, accountError(error), { fallback: '读取登录账号失败' });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, createSchema, { maxBytes: 16 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'login_account.create',
      userId,
    }, async () => {
      const account = await createLoginAccount({ userId, ...body });
      return apiJson(request, { account }, { status: 201 });
    });
  } catch (error) {
    return apiError(request, accountError(error), { fallback: '保存登录账号失败' });
  }
}
