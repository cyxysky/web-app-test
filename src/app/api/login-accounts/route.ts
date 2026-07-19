import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  createLoginAccount,
  listLoginAccounts,
} from '@/server/credentials/login-account-vault';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const createSchema = z.object({
  userId: z.union([z.string(), z.number()]).optional(),
  qzUserId: z.union([z.string(), z.number()]).optional(),
  domain: z.string().trim().min(1).max(1_000),
  username: z.string().trim().min(1).max(500),
  password: z.string().min(1).max(4_000),
  label: z.string().trim().max(500).optional(),
  loginUrl: z.string().trim().max(4_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict();

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

export async function GET(request: NextRequest) {
  try {
    const domain = request.nextUrl.searchParams.get('domain') || '';
    return noStoreJson({
      accounts: listLoginAccounts({
        userId: requestUserId(request),
        domain,
      }),
    });
  } catch (error) {
    return noStoreJson({ error: publicError(error) }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = createSchema.parse(await request.json());
    const account = createLoginAccount({
      userId: requestUserId(request, body),
      domain: body.domain,
      username: body.username,
      password: body.password,
      label: body.label,
      loginUrl: body.loginUrl,
      status: body.status,
    });
    return noStoreJson({ account }, { status: 201 });
  } catch (error) {
    const message = publicError(error);
    return noStoreJson(
      { error: message },
      { status: /已经存在/.test(message) ? 409 : 400 },
    );
  }
}
