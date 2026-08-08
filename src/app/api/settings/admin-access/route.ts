import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import {
  adminSettingsPasswordConfigured,
  adminSettingsPasswordEnabled,
  createAdminSettingsAccessToken,
  verifyAdminSettingsPassword,
} from '@/server/settings/admin-settings-access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const passwordSchema = z.object({ password: z.string().min(1).max(4_000) }).strict();

export async function POST(request: NextRequest) {
  try {
    if (!adminSettingsPasswordEnabled()) return apiJson(request, { ok: true, token: '' });
    if (!adminSettingsPasswordConfigured()) {
      throw new ApiRequestError('管理员设置密码尚未配置，请设置 WEBPILOT_ADMIN_SETTINGS_PASSWORD。', {
        code: 'admin_password_not_configured',
        status: 503,
      });
    }
    const body = await parseJsonRequest(request, passwordSchema, { maxBytes: 8 * 1024 });
    if (!verifyAdminSettingsPassword(body.password)) {
      throw new ApiRequestError('密码错误，请重新输入。', { code: 'invalid_admin_password', status: 401 });
    }
    return apiJson(request, { ok: true, token: createAdminSettingsAccessToken() });
  } catch (error) {
    return apiError(request, error, { fallback: '请输入管理员设置密码。' });
  }
}
