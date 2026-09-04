import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  resolveExternalIntegration,
  type ResolvedExternalIntegration,
} from '@/server/integrations/external-integration-vault';
import {
  resolveExternalIntegrationConfiguration,
  testExternalIntegration,
} from '@/server/integrations/external-integration-drivers';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

const configurationSchema = z.record(z.string().max(100), z.string().max(20_000)).refine(
  (value) => Object.keys(value).length <= 50,
  '配置字段过多。',
);
const testSchema = z.object({
  id: z.string().uuid().optional(),
  category: z.enum(['connector', 'communication', 'data', 'research']),
  driverId: z.string().trim().min(2).max(100),
  name: z.string().trim().min(1).max(200),
  configuration: configurationSchema,
  clearFields: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
}).strict();

function requireAdmin(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
  }
}

function streamIntegrationTest(request: NextRequest, candidate: ResolvedExternalIntegration, timeout: number) {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  return new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      let closed = false;
      const write = (event: unknown) => {
        if (closed) return;
        try {
          stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
          controller.abort(new Error('集成测试连接已关闭。'));
        }
      };
      void testExternalIntegration(candidate, timeout, signal, (progress) => {
        write({ type: 'progress', progress });
      }).then(
        (result) => write({ type: 'result', result }),
        (error) => write({
          type: 'error',
          message: error instanceof Error ? error.message.slice(0, 1_000) : '测试外部集成失败',
        }),
      ).finally(() => {
        if (closed) return;
        closed = true;
        try {
          stream.close();
        } catch {
          // The browser may have canceled the stream while the driver was finishing.
        }
      });
    },
    cancel() {
      controller.abort(new Error('集成测试已取消。'));
    },
  }), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    requireAdmin(request);
    const body = await parseJsonRequest(request, testSchema, { maxBytes: 128 * 1024 });
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
    const candidate: ResolvedExternalIntegration = {
      id: body.id || randomUUID(),
      category: body.category,
      driverId: body.driverId,
      name: body.name,
      configuration,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    const timeout = body.category === 'connector'
      ? Math.max(1_000, Number(process.env.AGENT_CONNECTOR_TIMEOUT_MS) || 30_000)
      : body.category === 'communication'
        ? Math.max(1_000, Number(process.env.AGENT_COMMUNICATION_TIMEOUT_MS) || 30_000)
        : body.category === 'research'
          ? Math.max(1_000, Number(process.env.AGENT_RESEARCH_TIMEOUT_MS) || 20_000)
          : 15_000;
    if (request.nextUrl.searchParams.get('stream') === '1') {
      return streamIntegrationTest(request, candidate, timeout);
    }
    return apiJson(request, { ok: true, result: await testExternalIntegration(candidate, timeout, request.signal) });
  } catch (error) {
    const reported = error instanceof ApiRequestError
      ? error
      : new ApiRequestError(error instanceof Error ? error.message.slice(0, 1_000) : '测试外部集成失败', {
        code: 'integration_test_failed',
      });
    return apiError(request, reported, { fallback: '测试外部集成失败' });
  }
}
