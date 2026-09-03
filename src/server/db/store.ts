import {
  defaultModelByProvider,
  defaultModelForProvider,
  defaultModelProviderSettings,
  modelListForProvider,
  modelProviderDefinitions,
  normalizeMiniMaxOpenAIBaseURL,
  migrateRuntimeEnvValue,
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
import { normalizedModelCapabilities } from '@/lib/model-capabilities';
import {
  DEFAULT_SENSITIVE_DATA_EVALUATION_CASES,
  normalizeSensitiveDataEvaluationCases,
  type SensitiveDataEvaluationCase,
} from '@/lib/sensitive-data-evaluation';
import {
  deleteSkillRecord,
  readConfigRecord,
  readRuntimeMeta,
  readSkillById,
  readSkillsByIds,
  readSkills,
  writeConfigRecord,
  writeRuntimeMeta,
  writeSkillRecord,
  writeSkillRecords,
  writeSkillRecordsQueued,
} from '@/server/storage/database-record-store';

type ConfigStoreData = {
  runtimeEnv: RuntimeEnvRecord[];
  modelConfig?: ModelConfigRecord;
};

const sensitiveDataEvaluationCasesMetaKey = 'sensitive-data-evaluation-cases';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

function normalizeExtraRequestParameters(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : '';
  } catch {
    return '';
  }
}

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
  groq: 'GROQ_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  'llama-cpp': 'LLAMA_CPP_API_KEY',
  lmstudio: 'LMSTUDIO_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  'openai-compatible-2': 'OPENAI_COMPATIBLE_2_API_KEY',
  'openai-compatible-3': 'OPENAI_COMPATIBLE_3_API_KEY',
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
  groq: 'GROQ_BASE_URL',
  huggingface: 'HUGGINGFACE_BASE_URL',
  'llama-cpp': 'LLAMA_CPP_BASE_URL',
  lmstudio: 'LMSTUDIO_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  mistral: 'MISTRAL_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
  'openai-compatible-2': 'OPENAI_COMPATIBLE_2_BASE_URL',
  'openai-compatible-3': 'OPENAI_COMPATIBLE_3_BASE_URL',
  openrouter: '',
  perplexity: 'PERPLEXITY_BASE_URL',
  togetherai: 'TOGETHERAI_BASE_URL',
  vercel: 'VERCEL_BASE_URL',
  xai: 'XAI_BASE_URL',
};

const modelExtraRequestParametersEnv: Partial<Record<ModelProvider, string>> = {
  minimax: 'MINIMAX_EXTRA_REQUEST_PARAMETERS',
  'openai-compatible': 'OPENAI_COMPATIBLE_EXTRA_REQUEST_PARAMETERS',
  'openai-compatible-2': 'OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS',
  'openai-compatible-3': 'OPENAI_COMPATIBLE_3_EXTRA_REQUEST_PARAMETERS',
};

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
    const baseURL = definition.value === 'minimax'
      ? normalizeMiniMaxOpenAIBaseURL(current?.baseURL)
      : current?.baseURL;
    providers[definition.value] = {
      ...defaultModelProviderSettings(definition.value),
      ...current,
      enabled: current?.enabled === true,
      defaultModel: model,
      model,
      models,
      modelCapabilities: normalizedModelCapabilities(definition.value, models, current?.modelCapabilities),
      baseURL: baseURL ?? definition.defaultBaseURL ?? '',
      extraRequestParameters: normalizeExtraRequestParameters(current?.extraRequestParameters),
    };
  }
  return { provider, providers, updatedAt: input.updatedAt || now() };
}

function applyModelConfig(config?: ModelConfigRecord) {
  const normalized = normalizeStoredModelConfig(config);
  if (!normalized) {
    process.env.AI_MODEL_PROVIDER_ENABLED = 'false';
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    return;
  }
  for (const definition of modelProviderDefinitions) {
    const settings = normalized.providers[definition.value] || defaultModelProviderSettings(definition.value);
    const keyEnv = modelApiKeyEnv[definition.value];
    if (keyEnv) process.env[keyEnv] = settings.apiKey || '';
    const baseUrlEnv = modelBaseUrlEnv[definition.value];
    if (baseUrlEnv) process.env[baseUrlEnv] = settings.baseURL || definition.defaultBaseURL || '';
    const extraRequestParametersEnv = modelExtraRequestParametersEnv[definition.value];
    if (extraRequestParametersEnv) process.env[extraRequestParametersEnv] = settings.extraRequestParameters || '';
  }
  const activeProvider = normalized.providers[normalized.provider]?.enabled
    ? normalized.provider
    : modelProviderDefinitions.find((definition) => normalized.providers[definition.value]?.enabled)?.value;
  if (!activeProvider) {
    process.env.AI_MODEL_PROVIDER_ENABLED = 'false';
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    return;
  }
  const active = normalized.providers[activeProvider] || defaultModelProviderSettings(activeProvider);
  process.env.AI_MODEL_PROVIDER_ENABLED = 'true';
  process.env.AI_PROVIDER = activeProvider;
  process.env.AI_MODEL = active.defaultModel || active.model || defaultModelByProvider[activeProvider];
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

function normalizeSkillContent(content?: Partial<SkillContent>): SkillContent {
  return {
    details: String(content?.details || '').trim().slice(0, 30_000),
  };
}

function normalizeSkillRecord(record: SkillRecord): SkillRecord {
  return {
    id: record.id,
    userId: normalizeApplicationUserId(record.userId),
    shared: record.shared === true,
    title: record.title,
    description: record.description,
    triggerPhrases: normalizeSkillItems(record.triggerPhrases, 8),
    content: normalizeSkillContent(record.content),
    sourceSessionId: record.sourceSessionId,
    status: record.status || 'ready',
    version: record.version || 1,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

type UpsertSkillInput = {
  id?: string;
  title: string;
  description: string;
  triggerPhrases?: string[];
  content: SkillContent;
  sourceSessionId?: string;
  status?: SkillRecord['status'];
  shared?: boolean;
  userId?: string | number;
};

function buildSkillRecord(input: UpsertSkillInput, existing: SkillRecord | undefined, userId: string, timestamp: string) {
  return normalizeSkillRecord({
    id: existing?.id || id('skl'),
    userId,
    shared: input.shared ?? existing?.shared ?? false,
    title: input.title.trim() || existing?.title || 'Runtime Skill',
    description: input.description.trim() || existing?.description || '',
    triggerPhrases: input.triggerPhrases || existing?.triggerPhrases || [],
    content: normalizeSkillContent(input.content),
    sourceSessionId: input.sourceSessionId || existing?.sourceSessionId,
    status: input.status || existing?.status || 'ready',
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  });
}

async function readConfigData(): Promise<ConfigStoreData> {
  const stored = await readConfigRecord() as Partial<ConfigStoreData>;
  return {
    runtimeEnv: stored.runtimeEnv || [],
    modelConfig: stored.modelConfig,
  };
}

async function writeConfigData(data: ConfigStoreData) {
  await writeConfigRecord(data);
}

export const store = {
  async listSkills(
    query?: string,
    userId?: string | number,
    limit?: number,
    cursor: { beforeId?: string; beforeUpdatedAt?: string } = {},
  ) {
    return (await readSkills(normalizeApplicationUserId(userId), { ...cursor, query, limit }))
      .map(normalizeSkillRecord);
  },
  async getSkill(skillId: string, userId?: string | number) {
    const skill = await readSkillById(skillId, normalizeApplicationUserId(userId));
    return skill ? normalizeSkillRecord(skill) : undefined;
  },
  async getSkills(skillIds: string[] = [], userId?: string | number) {
    const byId = new Map((await readSkillsByIds(skillIds, normalizeApplicationUserId(userId)))
      .map(normalizeSkillRecord)
      .map((skill) => [skill.id, skill]));
    return skillIds.map((skillId) => byId.get(skillId)).filter((item): item is SkillRecord => Boolean(item));
  },
  async upsertSkill(input: UpsertSkillInput) {
    const userId = normalizeApplicationUserId(input.userId);
    const timestamp = now();
    const storedExisting = input.id ? await readSkillById(input.id) : undefined;
    if (storedExisting && normalizeApplicationUserId(storedExisting.userId) !== userId) {
      throw new Error('Only the Skill creator can edit this shared Skill.');
    }
    const existing = storedExisting ? normalizeSkillRecord(storedExisting) : undefined;
    const skill = buildSkillRecord(input, existing, userId, timestamp);
    await writeSkillRecord(skill, userId);
    return skill;
  },
  async upsertSkillsBatch(inputs: UpsertSkillInput[], options: { queued?: boolean } = {}) {
    const existingById = new Map((await readSkills()).map((skill) => [skill.id, normalizeSkillRecord(skill)]));
    const records = inputs.map((input) => {
      const userId = normalizeApplicationUserId(input.userId);
      const existing = input.id ? existingById.get(input.id) : undefined;
      if (existing && normalizeApplicationUserId(existing.userId) !== userId) {
        throw new Error('Only the Skill creator can edit this shared Skill.');
      }
      const skill = buildSkillRecord(input, existing, userId, now());
      existingById.set(skill.id, skill);
      return { skill, userId };
    });
    if (options.queued) {
      await writeSkillRecordsQueued(records);
      return records.map((item) => item.skill);
    }
    await writeSkillRecords(records);
    return records.map((item) => item.skill);
  },
  async deleteSkill(skillId: string, userId?: string | number) {
    return deleteSkillRecord(skillId, normalizeApplicationUserId(userId));
  },
  async listRuntimeEnv() {
    return (await readConfigData()).runtimeEnv;
  },
  async listSensitiveDataEvaluationCases() {
    const serialized = await readRuntimeMeta(sensitiveDataEvaluationCasesMetaKey);
    if (!serialized) return normalizeSensitiveDataEvaluationCases(DEFAULT_SENSITIVE_DATA_EVALUATION_CASES);
    try {
      const storedCases = normalizeSensitiveDataEvaluationCases(JSON.parse(serialized));
      if (storedCases.some((item) => item.id === 'default-person-name-1')) {
        return normalizeSensitiveDataEvaluationCases(DEFAULT_SENSITIVE_DATA_EVALUATION_CASES);
      }
      return storedCases.length
        ? storedCases
        : normalizeSensitiveDataEvaluationCases(DEFAULT_SENSITIVE_DATA_EVALUATION_CASES);
    } catch {
      return normalizeSensitiveDataEvaluationCases(DEFAULT_SENSITIVE_DATA_EVALUATION_CASES);
    }
  },
  async saveSensitiveDataEvaluationCases(cases: SensitiveDataEvaluationCase[]) {
    const sensitiveDataEvaluationCases = normalizeSensitiveDataEvaluationCases(cases);
    await writeRuntimeMeta(sensitiveDataEvaluationCasesMetaKey, JSON.stringify(sensitiveDataEvaluationCases));
    return sensitiveDataEvaluationCases;
  },
  async getModelConfig() {
    return normalizeStoredModelConfig((await readConfigData()).modelConfig);
  },
  async saveModelConfig(input: Pick<ModelConfigRecord, 'provider' | 'providers'>) {
    const data = await readConfigData();
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
      const baseURL = current?.baseURL ?? previous?.baseURL ?? definition.defaultBaseURL ?? '';
      providers[provider] = {
        ...defaultModelProviderSettings(provider),
        ...merged,
        enabled: current?.enabled ?? previous?.enabled ?? false,
        defaultModel: model,
        model,
        models,
        modelCapabilities: normalizedModelCapabilities(provider, models, merged.modelCapabilities),
        apiKey: current?.apiKey ?? previous?.apiKey ?? '',
        baseURL: provider === 'minimax'
          ? normalizeMiniMaxOpenAIBaseURL(baseURL) || ''
          : baseURL,
        extraRequestParameters: normalizeExtraRequestParameters(current?.extraRequestParameters ?? previous?.extraRequestParameters),
        updatedAt: current ? timestamp : previous?.updatedAt,
      };
    }
    const config: ModelConfigRecord = { provider: input.provider, providers, updatedAt: timestamp };
    await writeConfigData({ ...data, modelConfig: config });
    applyModelConfig(config);
    return config;
  },
  async saveRuntimeEnv(items: Array<Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'>>) {
    const data = await readConfigData();
    const runtimeEnv = items.filter((item) => item.key.trim()).map((item) => ({
      key: item.key.trim(),
      value: item.value,
      enabled: item.enabled,
      secret: item.secret,
      updatedAt: now(),
    }));
    await writeConfigData({ ...data, runtimeEnv });
    return runtimeEnv;
  },
  async applyRuntimeEnv() {
    const data = await readConfigData();
    const allowedKeys = new Set(runtimeEnvKeys);
    const savedByKey = new Map(data.runtimeEnv.filter((item) => allowedKeys.has(item.key)).map((item) => [item.key, item]));
    for (const definition of runtimeEnvDefinitions) {
      const item = savedByKey.get(definition.key);
      if (item?.enabled === false) continue;
      const configuredValue = migrateRuntimeEnvValue(
        definition.key,
        item?.value ?? process.env[definition.key] ?? definition.defaultValue,
      );
      const deploymentValue = process.env[definition.key];
      if (!item && deploymentValue !== undefined && configuredValue === deploymentValue) continue;
      if (!configuredValue.trim() && deploymentValue?.trim()) continue;
      process.env[definition.key] = configuredValue;
    }
    applyModelConfig(data.modelConfig);
    return data.runtimeEnv;
  },
};
