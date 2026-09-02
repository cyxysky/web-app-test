import {
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinition,
  modelProviderDefinitions,
  migrateRuntimeEnvValue,
  runtimeEnvDefinitions,
} from '@/config/settings';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';
import { normalizedModelCapabilities } from '@/lib/model-capabilities';
import { store } from '@/server/db/store';

function defaultProviderSettings(provider: ModelProvider): ModelProviderSettings {
  const definition = modelProviderDefinition(provider);
  const models = modelListForProvider(definition);
  const model = defaultModelForProvider(definition);
  return {
    displayName: '',
    enabled: false,
    defaultModel: model,
    model,
    models,
    modelCapabilities: normalizedModelCapabilities(provider, models),
    apiKey: '',
    baseURL: definition.defaultBaseURL || '',
    extraRequestParameters: '',
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
      enabled: current?.enabled === true,
      defaultModel: model,
      model,
      models,
      modelCapabilities: normalizedModelCapabilities(definition.value, models, current?.modelCapabilities),
    };
  }
  return result;
}

export async function readRuntimeSettingsItems() {
  const savedByKey = new Map((await store.listRuntimeEnv()).map((item) => [item.key, item]));
  return runtimeEnvDefinitions.map((definition) => {
    const saved = savedByKey.get(definition.key);
    const secret = saved?.secret ?? Boolean(definition.secret);
    const value = migrateRuntimeEnvValue(
      definition.key,
      saved?.value ?? process.env[definition.key] ?? definition.defaultValue,
    );
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

export async function readModelSettingsState() {
  const saved = await store.getModelConfig();
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

export async function readEnvironmentSettingsSnapshot() {
  return {
    envItems: await readRuntimeSettingsItems(),
    modelConfig: (await readModelSettingsState()).config,
  };
}
