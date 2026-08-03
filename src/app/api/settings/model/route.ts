import { NextRequest, NextResponse } from 'next/server';
import { defaultModelByProvider, defaultModelForProvider, modelListForProvider, modelProviderDefinitions, modelProviderValues, modelProviderDefinition } from '@/config/settings';
import { store } from '@/server/db/store';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';
import { readModelSettingsState } from '@/server/settings/settings-snapshot';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

const providers = new Set<ModelProvider>(modelProviderValues);
const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };

function normalizeProvider(value: unknown): ModelProvider {
  const provider = String(value || 'openrouter').trim().toLowerCase();
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'gemini' || provider === 'gemini-cli') return 'google';
  if (provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  return providers.has(provider as ModelProvider) ? provider as ModelProvider : 'openrouter';
}

function readProviderSettings(value: unknown): Partial<Record<ModelProvider, ModelProviderSettings>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const raw = input[definition.value];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const rawModels = Array.isArray(item.models)
      ? item.models.map((model) => typeof model === 'string' ? model : '').filter(Boolean)
      : [];
    const models = modelListForProvider(definition, {
      models: rawModels,
      defaultModel: typeof item.defaultModel === 'string' ? item.defaultModel : undefined,
      model: typeof item.model === 'string' ? item.model : undefined,
    });
    const model = defaultModelForProvider(definition, {
      models,
      defaultModel: typeof item.defaultModel === 'string' ? item.defaultModel : undefined,
      model: typeof item.model === 'string' ? item.model : undefined,
    });
    result[definition.value] = {
      defaultModel: model,
      model,
      models,
      ...(typeof item.apiKey === 'string' && item.apiKey ? { apiKey: item.apiKey } : {}),
      baseURL: typeof item.baseURL === 'string' ? item.baseURL : definition.defaultBaseURL || '',
    };
  }
  return result;
}

export async function GET(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    return NextResponse.json({ error: '请先输入管理员设置密码。' }, { status: 401, headers: noStoreHeaders });
  }
  return NextResponse.json(readModelSettingsState(), { headers: noStoreHeaders });
}

export async function POST(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    return NextResponse.json({ error: '请先输入管理员设置密码。' }, { status: 401, headers: noStoreHeaders });
  }
  try {
    const body = await request.json();
    const provider = normalizeProvider(body.provider);
    const providersInput = readProviderSettings(body.providers);
    if (!Object.keys(providersInput).length) {
      const definition = modelProviderDefinition(provider);
      const bodyModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModelByProvider[provider];
      const models = modelListForProvider(definition, { model: bodyModel });
      const model = defaultModelForProvider(definition, { models, model: bodyModel });
      providersInput[provider] = {
        defaultModel: model,
        model,
        models,
        ...(typeof body.apiKey === 'string' && body.apiKey.trim() ? { apiKey: body.apiKey } : {}),
        baseURL: typeof body.baseURL === 'string' ? body.baseURL : modelProviderDefinition(provider).defaultBaseURL || '',
      };
    }
    store.saveModelConfig({
      provider,
      providers: providersInput,
    });
    store.applyRuntimeEnv();
    return NextResponse.json({ ok: true, ...readModelSettingsState() }, { headers: noStoreHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存模型配置失败' },
      { status: 400, headers: noStoreHeaders },
    );
  }
}
