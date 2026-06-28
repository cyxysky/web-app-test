import {
  defaultModelByProvider,
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinition,
  modelProviderDefinitions,
} from '@/config/settings';
import type { ModelConfigRecord, ModelProvider } from '@/server/ai/schemas/test-case.schema';

export type RuntimeModelConfig = Pick<ModelConfigRecord, 'provider' | 'providers' | 'updatedAt'>;

export type RuntimeModelOption = {
  description?: string;
  group?: string;
  label: string;
  selectedLabel?: string;
  value: string;
};

const modelSelectionSeparator = '::model::';

export function normalizeModelProvider(value?: string): ModelProvider {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'gemini' || provider === 'gemini-cli') return 'google';
  if (provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  return modelProviderDefinitions.some((item) => item.value === provider) ? provider as ModelProvider : 'openrouter';
}

export function modelSelectionValue(provider: ModelProvider, model: string) {
  return `${provider}${modelSelectionSeparator}${encodeURIComponent(model)}`;
}

export function parseModelSelectionValue(value: string): { provider: ModelProvider; model: string } {
  const [providerValue, encodedModel = ''] = value.split(modelSelectionSeparator);
  const provider = normalizeModelProvider(providerValue);
  const fallback = defaultModelByProvider[provider];
  try {
    return { provider, model: decodeURIComponent(encodedModel) || fallback };
  } catch {
    return { provider, model: fallback };
  }
}

function modelProviderSettings(config: RuntimeModelConfig | null | undefined, provider: ModelProvider) {
  return config?.providers?.[provider];
}

export function modelsForProvider(config: RuntimeModelConfig | null | undefined, provider: ModelProvider) {
  return modelListForProvider(modelProviderDefinition(provider), modelProviderSettings(config, provider));
}

export function defaultModelForConfig(config: RuntimeModelConfig | null | undefined, provider: ModelProvider) {
  return defaultModelForProvider(modelProviderDefinition(provider), modelProviderSettings(config, provider));
}

export function normalizeModelId(value: unknown, provider: ModelProvider, config?: RuntimeModelConfig | null) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (model && !config) return model;
  const models = modelsForProvider(config, provider);
  return model && models.includes(model) ? model : defaultModelForConfig(config, provider);
}

export function modelSelectionOptionsForConfig(config: RuntimeModelConfig | null | undefined): RuntimeModelOption[] {
  return modelProviderDefinitions.flatMap((provider) => {
    const models = modelsForProvider(config, provider.value);
    return models.map((model) => ({
      group: provider.label,
      label: model,
      selectedLabel: `${provider.label} - ${model}`,
      value: modelSelectionValue(provider.value, model),
    }));
  });
}
