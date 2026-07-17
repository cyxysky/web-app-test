import {
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinition,
  modelProviderDefinitions,
  runtimeEnvDefinitions,
} from '@/config/settings';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/test-case.schema';
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
    return {
      key: definition.key,
      value: saved?.value ?? definition.defaultValue,
      enabled: true,
      secret: saved?.secret ?? Boolean(definition.secret),
      updatedAt: saved?.updatedAt,
    };
  });
}

export function readModelSettingsState() {
  const saved = store.getModelConfig();
  return {
    saved: Boolean(saved),
    config: {
      provider: saved?.provider || 'openrouter',
      providers: completeProviders(saved?.providers),
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
