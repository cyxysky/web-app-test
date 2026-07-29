import {
  defaultModelByProvider,
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinition,
  modelProviderDefinitions,
  runtimeEnvDefinitions,
  runtimeEnvKeys,
} from '@/config/settings';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import type {
  ModelConfigRecord,
  ModelProvider,
  ModelProviderSettings,
  RuntimeEnvRecord,
  SkillContent,
  SkillRecord,
} from '@/server/ai/schemas/runtime.schema';
import {
  deleteSkillRecord,
  readConfigRecord,
  readSkills,
  writeConfigRecord,
  writeSkillRecord,
} from '@/server/storage/sqlite-record-store';

type ConfigStoreData = {
  runtimeEnv: RuntimeEnvRecord[];
  modelConfig?: ModelConfigRecord;
};

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const modelApiKeyEnv: Record<ModelProvider, string> = {
  'ai-gateway': 'AI_GATEWAY_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  bedrock: 'AWS_BEARER_TOKEN_BEDROCK',
  cerebras: 'CEREBRAS_API_KEY',
  codex: '',
  cohere: 'COHERE_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  'google-vertex': 'GOOGLE_VERTEX_API_KEY',
  groq: 'GROQ_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  'llama-cpp': 'LLAMA_CPP_API_KEY',
  lmstudio: 'LMSTUDIO_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  togetherai: 'TOGETHERAI_API_KEY',
  vercel: 'VERCEL_API_KEY',
  xai: 'XAI_API_KEY',
};

const modelBaseUrlEnv: Record<ModelProvider, string> = {
  'ai-gateway': 'AI_GATEWAY_BASE_URL',
  alibaba: 'ALIBABA_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  'azure-openai': 'AZURE_OPENAI_BASE_URL',
  bedrock: 'AWS_REGION',
  cerebras: 'CEREBRAS_BASE_URL',
  codex: '',
  cohere: 'COHERE_BASE_URL',
  deepinfra: 'DEEPINFRA_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
  fireworks: 'FIREWORKS_BASE_URL',
  google: '',
  'google-vertex': 'GOOGLE_VERTEX_BASE_URL',
  groq: 'GROQ_BASE_URL',
  huggingface: 'HUGGINGFACE_BASE_URL',
  'llama-cpp': 'LLAMA_CPP_BASE_URL',
  lmstudio: 'LMSTUDIO_BASE_URL',
  mistral: 'MISTRAL_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  openrouter: '',
  perplexity: 'PERPLEXITY_BASE_URL',
  togetherai: 'TOGETHERAI_BASE_URL',
  vercel: 'VERCEL_BASE_URL',
  xai: 'XAI_BASE_URL',
};

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

function normalizeStoredModelConfig(input?: ModelConfigRecord): ModelConfigRecord | undefined {
  if (!input) return undefined;
  const provider = modelProviderDefinitions.some((item) => item.value === input.provider)
    ? input.provider
    : 'openrouter';
  const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const current = input.providers?.[definition.value];
    const models = modelListForProvider(definition, current);
    const model = defaultModelForProvider(definition, current);
    providers[definition.value] = {
      ...defaultProviderSettings(definition.value),
      ...current,
      defaultModel: model,
      model,
      models,
    };
  }
  return { provider, providers, updatedAt: input.updatedAt || now() };
}

function applyModelConfig(config?: ModelConfigRecord) {
  const normalized = normalizeStoredModelConfig(config);
  if (!normalized) return;
  for (const definition of modelProviderDefinitions) {
    const settings = normalized.providers[definition.value] || defaultProviderSettings(definition.value);
    const keyEnv = modelApiKeyEnv[definition.value];
    if (keyEnv) process.env[keyEnv] = settings.apiKey || '';
    const baseUrlEnv = modelBaseUrlEnv[definition.value];
    if (baseUrlEnv) process.env[baseUrlEnv] = settings.baseURL || definition.defaultBaseURL || '';
  }
  const active = normalized.providers[normalized.provider] || defaultProviderSettings(normalized.provider);
  process.env.AI_PROVIDER = normalized.provider;
  process.env.AI_MODEL = active.defaultModel || active.model || defaultModelByProvider[normalized.provider];
}

function normalizeSkillItems(items: string[] | undefined, limit: number) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items || []) {
    const value = item.trim();
    const key = value.toLowerCase().replace(/\s+/g, ' ');
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function normalizeSkillContent(content?: Partial<SkillContent> & { cautions?: string[] }): SkillContent {
  return {
    workflow: normalizeSkillItems(content?.workflow, 8),
    recovery: normalizeSkillItems(content?.recovery || content?.cautions, 3),
    verification: normalizeSkillItems(content?.verification, 4),
  };
}

function normalizeSkillRecord(record: SkillRecord): SkillRecord {
  return {
    ...record,
    domains: normalizeSkillItems(record.domains, 12),
    tags: normalizeSkillItems(record.tags, 6),
    triggerPhrases: normalizeSkillItems(record.triggerPhrases, 8),
    content: normalizeSkillContent(record.content),
    status: record.status || 'ready',
    version: record.version || 1,
  };
}

function readConfigData(): ConfigStoreData {
  const stored = readConfigRecord() as Partial<ConfigStoreData>;
  return { runtimeEnv: stored.runtimeEnv || [], modelConfig: stored.modelConfig };
}

function writeConfigData(data: ConfigStoreData) {
  writeConfigRecord(data);
}

export const store = {
  listSkills(query?: string, userId?: string | number) {
    const normalizedQuery = (query || '').trim().toLowerCase();
    const skills = readSkills(normalizeApplicationUserId(userId))
      .map(normalizeSkillRecord)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (!normalizedQuery) return skills;
    return skills.filter((skill) => [
      skill.title,
      skill.description,
      ...(skill.domains || []),
      ...skill.tags,
      ...skill.triggerPhrases,
    ].some((value) => value.toLowerCase().includes(normalizedQuery)));
  },
  getSkill(skillId: string, userId?: string | number) {
    const skill = readSkills(normalizeApplicationUserId(userId)).find((item) => item.id === skillId);
    return skill ? normalizeSkillRecord(skill) : undefined;
  },
  getSkills(skillIds: string[] = [], userId?: string | number) {
    const byId = new Map(this.listSkills(undefined, userId).map((skill) => [skill.id, skill]));
    return skillIds.map((skillId) => byId.get(skillId)).filter((item): item is SkillRecord => Boolean(item));
  },
  upsertSkill(input: {
    id?: string;
    title: string;
    description: string;
    domains?: string[];
    tags?: string[];
    triggerPhrases?: string[];
    content: SkillContent;
    sourceSessionId?: string;
    status?: SkillRecord['status'];
    userId?: string | number;
  }) {
    const userId = normalizeApplicationUserId(input.userId);
    const timestamp = now();
    const existing = input.id ? this.getSkill(input.id, userId) : undefined;
    const skill = normalizeSkillRecord({
      id: existing?.id || id('skl'),
      title: input.title.trim() || existing?.title || 'Runtime Skill',
      description: input.description.trim() || existing?.description || '',
      domains: input.domains || existing?.domains || [],
      tags: input.tags || existing?.tags || [],
      triggerPhrases: input.triggerPhrases || existing?.triggerPhrases || [],
      content: normalizeSkillContent(input.content),
      sourceSessionId: input.sourceSessionId || existing?.sourceSessionId,
      status: input.status || existing?.status || 'ready',
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    writeSkillRecord(skill, userId);
    return skill;
  },
  deleteSkill(skillId: string, userId?: string | number) {
    return deleteSkillRecord(skillId, normalizeApplicationUserId(userId));
  },
  listRuntimeEnv() {
    return readConfigData().runtimeEnv;
  },
  getModelConfig() {
    return normalizeStoredModelConfig(readConfigData().modelConfig);
  },
  saveModelConfig(input: Pick<ModelConfigRecord, 'provider' | 'providers'>) {
    const data = readConfigData();
    const existing = normalizeStoredModelConfig(data.modelConfig);
    const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
    const timestamp = now();
    for (const definition of modelProviderDefinitions) {
      const provider = definition.value;
      const current = input.providers[provider];
      const previous = existing?.providers[provider];
      const merged = { ...previous, ...current };
      const models = modelListForProvider(definition, merged);
      const model = defaultModelForProvider(definition, { ...merged, models });
      providers[provider] = {
        ...defaultProviderSettings(provider),
        ...merged,
        defaultModel: model,
        model,
        models,
        apiKey: current?.apiKey ?? previous?.apiKey ?? '',
        baseURL: current?.baseURL ?? previous?.baseURL ?? definition.defaultBaseURL ?? '',
        updatedAt: current ? timestamp : previous?.updatedAt,
      };
    }
    const config: ModelConfigRecord = { provider: input.provider, providers, updatedAt: timestamp };
    writeConfigData({ ...data, modelConfig: config });
    applyModelConfig(config);
    return config;
  },
  saveRuntimeEnv(items: Array<Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'>>) {
    const data = readConfigData();
    const runtimeEnv = items.filter((item) => item.key.trim()).map((item) => ({
      key: item.key.trim(),
      value: item.value,
      enabled: item.enabled,
      secret: item.secret,
      updatedAt: now(),
    }));
    writeConfigData({ ...data, runtimeEnv });
    return runtimeEnv;
  },
  applyRuntimeEnv() {
    const data = readConfigData();
    const allowedKeys = new Set(runtimeEnvKeys);
    const savedByKey = new Map(data.runtimeEnv.filter((item) => allowedKeys.has(item.key)).map((item) => [item.key, item]));
    for (const definition of runtimeEnvDefinitions) {
      const item = savedByKey.get(definition.key);
      if (item?.enabled === false) continue;
      process.env[definition.key] = item?.value ?? definition.defaultValue;
    }
    applyModelConfig(data.modelConfig);
    return data.runtimeEnv;
  },
};
