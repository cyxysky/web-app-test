import { NextRequest } from 'next/server';
import { z } from 'zod';
import { defaultModelForProvider, modelListForProvider, modelProviderDefinition, modelProviderValues } from '@/config/settings';
import type { ModelProvider } from '@/server/ai/schemas/runtime.schema';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { readModelSettingsState } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const selectionSchema = z.object({
  model: z.string().trim().min(1).max(500),
  provider: z.enum(modelProviderValues as [ModelProvider, ...ModelProvider[]]),
}).strict();

export async function GET(request: NextRequest) {
  return apiJson(request, readModelSettingsState());
}

export async function POST(request: NextRequest) {
  try {
    const selection = await parseJsonRequest(request, selectionSchema, { maxBytes: 8 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(selection),
      scope: 'settings.model_selection',
      userId,
    }, () => {
      const saved = store.getModelConfig();
      const definition = modelProviderDefinition(selection.provider);
      const currentProvider = saved?.providers?.[selection.provider];
      const models = modelListForProvider(definition, {
        ...currentProvider,
        models: [...(currentProvider?.models || []), selection.model],
      });
      const model = defaultModelForProvider(definition, { ...currentProvider, defaultModel: selection.model, model: selection.model, models });
      store.saveModelConfig({
        provider: selection.provider,
        providers: {
          ...(saved?.providers || {}),
          [selection.provider]: {
            ...currentProvider,
            baseURL: currentProvider?.baseURL ?? definition.defaultBaseURL ?? '',
            defaultModel: model,
            model,
            models,
          },
        },
      });
      store.applyRuntimeEnv();
      return apiJson(request, { ok: true, ...readModelSettingsState() });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '保存模型选择失败' });
  }
}
