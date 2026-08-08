import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  exportPortableData,
  importPortableData,
} from '@/server/settings/portable-data';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const requestSchema = z.object({
  operation: z.enum(['export', 'import']),
  kind: z.enum(['credentials', 'skills', 'memory', 'model']),
  passphrase: z.string().max(1_024).optional(),
  bundle: z.unknown().optional(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, requestSchema, { maxBytes: 32 * 1024 * 1024 });
    if (body.kind === 'model' && !requestHasAdminSettingsAccess(request)) {
      throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
    }
    const userId = requestApplicationUserId(request);
    if (body.operation === 'export') {
      return apiJson(request, await exportPortableData({
        kind: body.kind,
        userId,
        passphrase: body.passphrase,
      }));
    }
    if (body.bundle === undefined) throw new ApiRequestError('请选择有效的导入文件。');
    return await runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ kind: body.kind, bundle: body.bundle }),
      scope: `data-transfer.import.${body.kind}`,
      userId,
    }, async () => apiJson(request, await importPortableData({
        kind: body.kind,
        userId,
        passphrase: body.passphrase,
        bundle: body.bundle,
      })));
  } catch (error) {
    const normalizedError = error instanceof ApiRequestError
      ? error
      : error instanceof z.ZodError
        ? new ApiRequestError('导入导出数据格式无效', { code: 'validation_failed' })
        : error instanceof Error
          ? new ApiRequestError(error.message, { code: 'data_transfer_failed' })
          : error;
    return apiError(request, normalizedError, {
      code: 'data_transfer_failed',
      fallback: '导入或导出失败',
    });
  }
}
