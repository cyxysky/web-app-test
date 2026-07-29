import {
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinition,
  modelProviderDefinitions,
  runtimeEnvDefinitions,
} from '@/config/settings';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';
import { store } from '@/server/db/store';

function defaultProviderSettings(provider: ModelProvider): ModelProviderSettings {
  const definition = modelProviderDefinition(provider);
  const models = modelListForProvider(definition);
  const model = defaultModelForProvider(definition);
  return {
    defaultModel: model,
    model,
    models,
    apiKey: '',
    baseURL: definition.defaultBaseURL || '',
  };
}

function completeProviders(input?: Partial<Record<ModelProvider, ModelProviderSettings>>) {
  const result: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const current = input?.[definition.value];
    const models = modelListForProvider(definition, current);
    const model = defaultModelForProvider(definition, current);
    result[definition.value] = {
      ...defaultProviderSettings(definition.value),
      ...current,
      defaultModel: model,
      model,
      models,
    };
  }
  return result;
}

export function readRuntimeSettingsItems() {
  const savedByKey = new Map(store.listRuntimeEnv().map((item) => [item.key, item]));
  return runtimeEnvDefinitions.map((definition) => {
    const saved = savedByKey.get(definition.key);
    const secret = saved?.secret ?? Boolean(definition.secret);
    const value = saved?.value ?? definition.defaultValue;
    return {
      key: definition.key,
      value: secret ? '' : value,
      hasValue: secret ? Boolean(value) : undefined,
      enabled: true,
      secret,
      updatedAt: saved?.updatedAt,
    };
  });
}

export function readModelSettingsState() {
  const saved = store.getModelConfig();
  const providers = completeProviders(saved?.providers);
  for (const provider of Object.keys(providers) as ModelProvider[]) {
    const current = providers[provider];
    if (!current) continue;
    providers[provider] = {
      ...current,
      apiKey: '',
      hasApiKey: Boolean(current.apiKey),
    };
  }
  return {
    saved: Boolean(saved),
    config: {
      provider: saved?.provider || 'openrouter',
      providers,
      updatedAt: saved?.updatedAt || '',
    },
  };
}

export function readEnvironmentSettingsSnapshot() {
  return {
    envItems: readRuntimeSettingsItems(),
    modelConfig: readModelSettingsState().config,
  };
}
