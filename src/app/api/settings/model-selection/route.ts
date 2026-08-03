import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinition,
  modelProviderValues,
} from '@/config/settings';
import { store } from '@/server/db/store';
import { noStoreJson } from '@/server/http/no-store-response';
import type { ModelProvider } from '@/server/ai/schemas/runtime.schema';
import { readModelSettingsState } from '@/server/settings/settings-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const selectionSchema = z.object({
  model: z.string().trim().min(1).max(500),
  provider: z.enum(modelProviderValues as [ModelProvider, ...ModelProvider[]]),
}).strict();

export async function GET() {
  return noStoreJson(readModelSettingsState());
}

export async function POST(request: NextRequest) {
  try {
    const selection = selectionSchema.parse(await request.json());
    const saved = store.getModelConfig();
    const definition = modelProviderDefinition(selection.provider);
    const currentProvider = saved?.providers?.[selection.provider];
    const models = modelListForProvider(definition, {
      ...currentProvider,
      models: [...(currentProvider?.models || []), selection.model],
    });
    const model = defaultModelForProvider(definition, {
      ...currentProvider,
      defaultModel: selection.model,
      model: selection.model,
      models,
    });
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
    return noStoreJson({ ok: true, ...readModelSettingsState() });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? '模型选择格式无效'
      : error instanceof Error ? error.message : '保存模型选择失败';
    return noStoreJson({ error: message }, { status: 400 });
  }
}
