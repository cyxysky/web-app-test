import { NextRequest } from 'next/server';
import { z } from 'zod';
import { normalizeRuntimeEnvValue, runtimeEnvDefinitions } from '@/config/settings';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';
import { readRuntimeSettingsItems } from '@/server/settings/settings-snapshot';

const allowedKeys = new Set(runtimeEnvDefinitions.map((item) => item.key));
const envSchema = z.object({
  items: z.array(z.object({
    key: z.string().max(200),
    value: z.unknown().optional(),
  }).passthrough()).max(500),
}).strict();

function requireAdmin(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
  }
}

export async function GET(request: NextRequest) {
  try {
    requireAdmin(request);
    return apiJson(request, { saved: await readRuntimeSettingsItems() });
  } catch (error) {
    return apiError(request, error, { fallback: '读取环境配置失败' });
  }
}

export async function POST(request: NextRequest) {
  try {
    requireAdmin(request);
    const body = await parseJsonRequest(request, envSchema, { maxBytes: 256 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'settings.environment',
      userId,
    }, async () => {
      const incomingByKey = new Map(body.items
        .filter((item) => allowedKeys.has(item.key))
        .map((item) => [item.key, item]));
      const savedByKey = new Map((await store.listRuntimeEnv()).map((item) => [item.key, item]));
      const sanitized = runtimeEnvDefinitions.map((definition) => {
        const item = incomingByKey.get(definition.key);
        const secret = Boolean(definition.secret);
        const submittedValue = typeof item?.value === 'string' ? item.value : '';
        return {
          key: definition.key,
          value: secret && !submittedValue
            ? savedByKey.get(definition.key)?.value ?? process.env[definition.key] ?? definition.defaultValue
            : typeof item?.value === 'string' ? normalizeRuntimeEnvValue(definition, submittedValue) : definition.defaultValue,
          enabled: true,
          secret,
        };
      });
      await store.saveRuntimeEnv(sanitized);
      await store.applyRuntimeEnv();
      return apiJson(request, { ok: true, saved: await readRuntimeSettingsItems() });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '保存环境配置失败' });
  }
}
