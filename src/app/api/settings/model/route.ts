import { NextRequest, NextResponse } from 'next/server';
import { defaultModelByProvider, modelProviderDefinitions, modelProviderValues, modelProviderDefinition } from '@/config/settings';
import { store } from '@/server/db/mock-store';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/test-case.schema';

const providers = new Set<ModelProvider>(modelProviderValues);

function normalizeProvider(value: unknown): ModelProvider {
  const provider = String(value || 'openrouter').trim().toLowerCase();
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'gemini' || provider === 'gemini-cli') return 'gemini';
  if (provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  return providers.has(provider as ModelProvider) ? provider as ModelProvider : 'openrouter';
}

function defaultProviderSettings(provider: ModelProvider): ModelProviderSettings {
  return {
    model: defaultModelByProvider[provider],
    apiKey: '',
    baseURL: modelProviderDefinition(provider).defaultBaseURL || '',
  };
}

function completeProviders(input?: Partial<Record<ModelProvider, ModelProviderSettings>>) {
  const result: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const current = input?.[definition.value];
    result[definition.value] = {
      ...defaultProviderSettings(definition.value),
      ...current,
      model: current?.model?.trim() || definition.defaultModel,
    };
  }
  return result;
}

function readProviderSettings(value: unknown): Partial<Record<ModelProvider, ModelProviderSettings>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const raw = input[definition.value];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    result[definition.value] = {
      model: typeof item.model === 'string' && item.model.trim() ? item.model.trim() : definition.defaultModel,
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      baseURL: typeof item.baseURL === 'string' ? item.baseURL : definition.defaultBaseURL || '',
    };
  }
  return result;
}

export async function GET() {
  await store.applyRuntimeEnv();
  const saved = await store.getModelConfig();
  const provider = saved?.provider || 'openrouter';
  return NextResponse.json({
    saved: Boolean(saved),
    config: {
      provider,
      providers: completeProviders(saved?.providers),
      updatedAt: saved?.updatedAt,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const provider = normalizeProvider(body.provider);
    const providersInput = readProviderSettings(body.providers);
    if (!Object.keys(providersInput).length) {
      providersInput[provider] = {
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModelByProvider[provider],
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
        baseURL: typeof body.baseURL === 'string' ? body.baseURL : modelProviderDefinition(provider).defaultBaseURL || '',
      };
    }
    const config = await store.saveModelConfig({
      provider,
      providers: providersInput,
    });
    await store.applyRuntimeEnv();
    return NextResponse.json({ ok: true, config });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存模型配置失败' },
      { status: 400 },
    );
  }
}
