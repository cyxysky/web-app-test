import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { saveBrowserDomainCookie } from '@/server/credentials/browser-domain-cookie-vault';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const saveCookieSchema = z.object({
  userId: z.union([z.string(), z.number().int()])
    .transform((value) => String(value).trim())
    .pipe(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
  domain: z.string().trim().min(1).max(253),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, saveCookieSchema, { maxBytes: 4 * 1024 });
    const authenticatedUserId = requestApplicationUserId(request);
    if (body.userId !== authenticatedUserId) {
      throw new ApiRequestError('不能为其他用户保存浏览器 Cookie', {
        code: 'forbidden',
        status: 403,
      });
    }
    const cookie = String(request.headers.get('cookie') || '').trim();
    if (!cookie) {
      throw new ApiRequestError('请求头中没有 Cookie', {
        code: 'browser_cookie_missing',
      });
    }
    if (Buffer.byteLength(cookie, 'utf8') > 64 * 1024) {
      throw new ApiRequestError('Cookie 请求头过大', {
        code: 'browser_cookie_too_large',
        status: 413,
      });
    }
    const saved = saveBrowserDomainCookie(authenticatedUserId, body.domain, cookie);
    return apiJson(request, saved, { status: 201 });
  } catch (error) {
    const normalized = error instanceof ApiRequestError
      ? error
      : new ApiRequestError(error instanceof Error ? error.message : '保存浏览器 Cookie 失败', {
        code: 'browser_cookie_invalid',
      });
    return apiError(request, normalized, { fallback: '保存浏览器 Cookie 失败' });
  }
}
