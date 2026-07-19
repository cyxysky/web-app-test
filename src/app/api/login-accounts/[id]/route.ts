import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  deleteLoginAccount,
  updateLoginAccount,
} from '@/server/credentials/login-account-vault';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  userId: z.union([z.string(), z.number()]).optional(),
  qzUserId: z.union([z.string(), z.number()]).optional(),
  domain: z.string().trim().min(1).max(1_000).optional(),
  username: z.string().trim().min(1).max(500).optional(),
  password: z.string().max(4_000).optional(),
  label: z.string().trim().max(500).optional(),
  loginUrl: z.string().trim().max(4_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict().refine((body) => (
  body.domain !== undefined
  || body.username !== undefined
  || body.password !== undefined
  || body.label !== undefined
  || body.loginUrl !== undefined
  || body.status !== undefined
), { message: '没有可更新的账号字段' });

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  return String(
    body?.userId
    ?? body?.qzUserId
    ?? request.nextUrl.searchParams.get('userId')
    ?? request.nextUrl.searchParams.get('qzUserId')
    ?? '',
  ).trim();
}

function publicError(error: unknown) {
  if (error instanceof z.ZodError) return '账号信息格式无效';
  return error instanceof Error ? error.message : '登录账号操作失败';
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = updateSchema.parse(await request.json());
    const account = updateLoginAccount(id, {
      domain: body.domain,
      username: body.username,
      password: body.password,
      label: body.label,
      loginUrl: body.loginUrl,
      status: body.status,
    }, requestUserId(request, body));
    if (!account) return noStoreJson({ error: '登录账号不存在' }, { status: 404 });
    return noStoreJson({ account });
  } catch (error) {
    const message = publicError(error);
    return noStoreJson(
      { error: message },
      { status: /已经存在/.test(message) ? 409 : 400 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const deleted = deleteLoginAccount(id, requestUserId(request));
    if (!deleted) return noStoreJson({ error: '登录账号不存在' }, { status: 404 });
    return noStoreJson({ ok: true });
  } catch (error) {
    return noStoreJson({ error: publicError(error) }, { status: 400 });
  }
}
