import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  deleteExternalIntegration,
  listExternalIntegrations,
  resolveExternalIntegration,
  upsertExternalIntegration,
} from '@/server/integrations/external-integration-vault';
import {
  listExternalIntegrationDrivers,
  publicExternalIntegrationSummary,
  resolveExternalIntegrationConfiguration,
} from '@/server/integrations/external-integration-drivers';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

const categorySchema = z.enum(['connector', 'communication', 'data', 'research']);
const configurationSchema = z.record(z.string().max(100), z.string().max(20_000)).refine(
  (value) => Object.keys(value).length <= 50,
  '配置字段过多。',
);
const integrationSchema = z.object({
  id: z.string().uuid().optional(),
  category: categorySchema,
  driverId: z.string().trim().min(2).max(100),
  name: z.string().trim().min(1).max(200),
  configuration: configurationSchema,
  clearFields: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  enabled: z.boolean(),
}).strict();

function requireAdmin(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
  }
}

export async function GET(request: NextRequest) {
  try {
    requireAdmin(request);
    const requestedCategory = request.nextUrl.searchParams.get('category');
    const category = requestedCategory ? categorySchema.parse(requestedCategory) : undefined;
    const integrations = await listExternalIntegrations(category);
    return apiJson(request, {
      items: integrations.map(publicExternalIntegrationSummary),
      drivers: listExternalIntegrationDrivers(category),
    });
  } catch (error) {
    return apiError(request, error, { fallback: '读取外部集成失败' });
  }
}

export async function POST(request: NextRequest) {
  try {
    requireAdmin(request);
    const body = await parseJsonRequest(request, integrationSchema, { maxBytes: 128 * 1024 });
    const existing = body.id ? await resolveExternalIntegration(body.id) : undefined;
    if (body.id && !existing) {
      throw new ApiRequestError('外部集成不存在。', { code: 'integration_not_found', status: 404 });
    }
    const configuration = resolveExternalIntegrationConfiguration({
      driverId: body.driverId,
      category: body.category,
      configuration: body.configuration,
      clearFields: body.clearFields,
      existing,
    });
    const item = await upsertExternalIntegration({
      id: body.id,
      category: body.category,
      driverId: body.driverId,
      name: body.name,
      configuration,
      enabled: body.enabled,
    });
    return apiJson(request, { ok: true, item: publicExternalIntegrationSummary(item) });
  } catch (error) {
    return apiError(request, error, { fallback: '保存外部集成失败' });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    requireAdmin(request);
    const id = request.nextUrl.searchParams.get('id')?.trim();
    if (!id || !z.string().uuid().safeParse(id).success) {
      throw new ApiRequestError('外部集成 ID 无效。', { code: 'invalid_integration_id' });
    }
    if (!(await deleteExternalIntegration(id))) {
      throw new ApiRequestError('外部集成不存在。', { code: 'integration_not_found', status: 404 });
    }
    return apiJson(request, { ok: true });
  } catch (error) {
    return apiError(request, error, { fallback: '删除外部集成失败' });
  }
}
