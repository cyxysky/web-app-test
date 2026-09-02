import { NextRequest } from 'next/server';
import { z } from 'zod';
import { redactSensitiveTexts } from '@/server/ai/sensitive-data-filter';
import { store } from '@/server/db/store';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

const testRequestSchema = z.object({
  text: z.string().min(1).max(200_000),
}).strict();

export async function POST(request: NextRequest) {
  try {
    if (!requestHasAdminSettingsAccess(request)) {
      throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
    }
    const body = await parseJsonRequest(request, testRequestSchema, { maxBytes: 256 * 1024 });
    await store.applyRuntimeEnv();
    const result = await redactSensitiveTexts([body.text], request.signal);
    return apiJson(request, {
      text: result.texts[0] || '',
      replacements: result.replacements
        .filter((replacement) => replacement.textIndex === 0)
        .map((replacement) => ({
          original: body.text.slice(replacement.start, replacement.end),
          placeholder: replacement.placeholder,
          label: replacement.label,
          start: replacement.start,
          end: replacement.end,
        })),
    });
  } catch (error) {
    return apiError(request, error, { fallback: '敏感数据过滤测试失败' });
  }
}
