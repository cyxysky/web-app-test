import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  exportPortableData,
  importPortableData,
} from '@/server/settings/portable-data';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';
import { requestApplicationUserId } from '@/server/auth/user-context';

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
    const body = requestSchema.parse(await request.json());
    if (body.kind === 'model' && !requestHasAdminSettingsAccess(request)) {
      return noStoreJson({ error: '请先输入管理员设置密码。' }, { status: 401 });
    }
    const userId = requestApplicationUserId(request);
    if (body.operation === 'export') {
      return noStoreJson(exportPortableData({
        kind: body.kind,
        userId,
        passphrase: body.passphrase,
      }));
    }
    if (body.bundle === undefined) throw new Error('请选择有效的导入文件');
    return noStoreJson(importPortableData({
      kind: body.kind,
      userId,
      passphrase: body.passphrase,
      bundle: body.bundle,
    }));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? '导入导出数据格式无效'
      : error instanceof Error ? error.message : '导入导出失败';
    return noStoreJson({ error: message }, { status: 400 });
  }
}
