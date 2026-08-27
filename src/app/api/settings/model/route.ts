import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  defaultModelByProvider,
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinitions,
  modelProviderDefinition,
  modelProviderValues,
} from '@/config/settings';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';
import { normalizedModelCapabilities } from '@/lib/model-capabilities';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';
import { readModelSettingsState } from '@/server/settings/settings-snapshot';

const providers = new Set<ModelProvider>(modelProviderValues);
const modelBodySchema = z.record(z.string(), z.unknown());

function normalizeExtraRequestParameters(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.length > 16_000) {
    throw new ApiRequestError('Extra request parameters must be at most 16 KB.', { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiRequestError('Extra request parameters must be valid JSON.', { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiRequestError('Extra request parameters must be a JSON object.', { status: 400 });
  }
  return JSON.stringify(parsed);
}

function requireAdmin(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
  }
}

function normalizeProvider(value: unknown): ModelProvider {
  const provider = String(value || 'openrouter').trim().toLowerCase();
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'gemini' || provider === 'gemini-cli') return 'google';
  if (provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  if (provider === 'openai-compatible-1' || provider === 'openai-compatible-api' || provider === 'custom-openai' || provider === 'custom-openai-1') return 'openai-compatible';
  if (provider === 'custom-openai-2') return 'openai-compatible-2';
  if (provider === 'custom-openai-3') return 'openai-compatible-3';
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
    const rawCapabilities = item.modelCapabilities && typeof item.modelCapabilities === 'object' && !Array.isArray(item.modelCapabilities)
      ? item.modelCapabilities as Record<string, unknown>
      : {};
    const configuredCapabilities = Object.fromEntries(Object.entries(rawCapabilities).flatMap(([modelId, capability]) => {
      if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return [];
      const imageInput = (capability as Record<string, unknown>).imageInput;
      return typeof imageInput === 'boolean' ? [[modelId, { imageInput }]] : [];
    }));
    result[definition.value] = {
      displayName: typeof item.displayName === 'string' ? item.displayName.trim().slice(0, 80) : '',
      enabled: item.enabled === true,
      defaultModel: model,
      model,
      models,
      modelCapabilities: normalizedModelCapabilities(definition.value, models, configuredCapabilities),
      ...(typeof item.apiKey === 'string' && item.apiKey ? { apiKey: item.apiKey } : {}),
      baseURL: typeof item.baseURL === 'string' ? item.baseURL : definition.defaultBaseURL || '',
      extraRequestParameters: normalizeExtraRequestParameters(item.extraRequestParameters),
    };
  }
  return result;
}

export async function GET(request: NextRequest) {
  try {
    requireAdmin(request);
    return apiJson(request, readModelSettingsState());
  } catch (error) {
    return apiError(request, error, { fallback: '读取模型配置失败' });
  }
}

export async function POST(request: NextRequest) {
  try {
    requireAdmin(request);
    const body = await parseJsonRequest(request, modelBodySchema, { maxBytes: 512 * 1024 });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'settings.model',
      userId,
    }, () => {
      const provider = normalizeProvider(body.provider);
      const providersInput = readProviderSettings(body.providers);
      if (!Object.keys(providersInput).length) {
        const definition = modelProviderDefinition(provider);
        const bodyModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModelByProvider[provider];
        const models = modelListForProvider(definition, { model: bodyModel });
        const model = defaultModelForProvider(definition, { models, model: bodyModel });
        providersInput[provider] = {
          enabled: false,
          defaultModel: model,
          model,
          models,
          modelCapabilities: normalizedModelCapabilities(provider, models),
          ...(typeof body.apiKey === 'string' && body.apiKey.trim() ? { apiKey: body.apiKey } : {}),
          baseURL: typeof body.baseURL === 'string' ? body.baseURL : definition.defaultBaseURL || '',
          extraRequestParameters: normalizeExtraRequestParameters(body.extraRequestParameters),
        };
      }
      store.saveModelConfig({ provider, providers: providersInput });
      store.applyRuntimeEnv();
      return apiJson(request, { ok: true, ...readModelSettingsState() });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '保存模型配置失败' });
  }
}
