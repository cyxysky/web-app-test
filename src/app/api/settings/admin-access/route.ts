import { NextRequest } from 'next/server';
import { noStoreJson } from '@/server/http/no-store-response';
import {
  adminSettingsPasswordConfigured,
  adminSettingsPasswordEnabled,
  createAdminSettingsAccessToken,
  verifyAdminSettingsPassword,
} from '@/server/settings/admin-settings-access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  if (!adminSettingsPasswordEnabled()) return noStoreJson({ ok: true, token: '' });
  if (!adminSettingsPasswordConfigured()) {
    return noStoreJson(
      { error: '管理员设置密码尚未配置，请设置 WEBPILOT_ADMIN_SETTINGS_PASSWORD。' },
      { status: 503 },
    );
  }
  try {
    const body = await request.json() as { password?: unknown };
    if (!verifyAdminSettingsPassword(body.password)) {
      return noStoreJson({ error: '密码错误，请重新输入。' }, { status: 401 });
    }
    return noStoreJson({ ok: true, token: createAdminSettingsAccessToken() });
  } catch {
    return noStoreJson({ error: '请输入管理员设置密码。' }, { status: 400 });
  }
}
