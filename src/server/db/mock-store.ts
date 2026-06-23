import { existsSync, readFileSync } from 'node:fs';
import { defaultModelByProvider, modelProviderDefinitions, modelProviderDefinition, runtimeEnvDefinitions, runtimeEnvKeys } from '@/config/settings';
import type { ModelConfigRecord, ModelProvider, ModelProviderSettings, RunDebugEvent, RunScheduleRecord, RuntimeEnvRecord, SkillContent, SkillRecord, StepExecutionResult, TaskLedgerItem, TestCaseContent, TestCaseRecord, TestGroupRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { publishRefreshEvent } from '@/server/realtime/ws-refresh';
import { sleepSync, writeJsonFileAtomic } from '@/server/storage/atomic-json';
import { storeFilePath } from '@/server/storage/paths';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const storePath = storeFilePath();

function notifyRunUpdate(runId: string, run: TestRunRecord) {
  publishRefreshEvent({ entityType: 'run', id: runId, updatedAt: run.endedAt || run.startedAt || now() });
}

function notifyRunDeleted(runId: string) {
  publishRefreshEvent({ entityType: 'run', id: runId, deleted: true });
}

function notifyRunsDeleted(runIds: Iterable<string>) {
  for (const runId of new Set([...runIds].filter(Boolean))) notifyRunDeleted(runId);
}

const seedContent: TestCaseContent = {
  title: 'Login smoke test',
  description: 'Verify the login page loads, rejects an invalid password, and supports a successful test login.',
  targetUrl: 'https://example.com',
  priority: 'high',
  browserMode: 'default',
  isMarked: true,
  preconditions: ['The test environment is reachable', 'A test account is available', 'The target domain is allowlisted'],
  testData: {
    username: 'demo@example.com',
    password: '******',
  },
  steps: [
    {
      index: 1,
      operation: 'wait',
      action: 'Open the login page and verify it finishes loading',
      expected: 'The page shows login-related content',
      riskLevel: 'safe',
    },
    {
      index: 2,
      operation: 'fill',
      action: 'Submit an invalid password',
      input: 'wrong-password',
      expected: 'The page shows an error and does not enter the app',
      riskLevel: 'safe',
    },
    {
      index: 3,
      operation: 'fill',
      action: 'Submit the configured test account',
      input: 'configured test credential',
      expected: 'Login succeeds and navigates to the dashboard or home page',
      riskLevel: 'warning',
    },
  ],
  expectedResults: ['The login page is reachable', 'Invalid credentials show a clear error', 'Valid test credentials enter the app'],
  risks: ['Use an isolated test account only. Do not connect production accounts.'],
};

type StoreData = {
  testCases: TestCaseRecord[];
  runs: TestRunRecord[];
  groups?: TestGroupRecord[];
  skills?: SkillRecord[];
  runtimeEnv?: RuntimeEnvRecord[];
  modelConfig?: ModelConfigRecord;
  schedules?: RunScheduleRecord[];
};

const seedRecord: TestCaseRecord = {
  id: 'tc_demo_login',
  title: seedContent.title,
  description: seedContent.description,
  targetUrl: seedContent.targetUrl,
  status: 'ready',
  priority: seedContent.priority,
  content: seedContent,
  imageNames: [],
  createdAt: now(),
  updatedAt: now(),
};

function compactText(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeModelProvider(value: string): ModelProvider {
  const provider = value.trim().toLowerCase();
  if (provider === 'ai-gateway' || provider === 'gateway' || provider === 'vercel-ai-gateway') return 'ai-gateway';
  if (provider === 'alibaba' || provider === 'aliyun' || provider === 'dashscope') return 'alibaba';
  if (provider === 'anthropic' || provider === 'claude') return 'anthropic';
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'bedrock' || provider === 'amazon-bedrock' || provider === 'aws-bedrock') return 'bedrock';
  if (provider === 'cerebras') return 'cerebras';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'cohere') return 'cohere';
  if (provider === 'deepinfra') return 'deepinfra';
  if (provider === 'deepseek') return 'deepseek';
  if (provider === 'fireworks' || provider === 'fireworks-ai') return 'fireworks';
  if (provider === 'gemini' || provider === 'gemini-cli' || provider === 'google') return 'google';
  if (provider === 'google-vertex' || provider === 'vertex' || provider === 'vertex-ai') return 'google-vertex';
  if (provider === 'groq') return 'groq';
  if (provider === 'huggingface' || provider === 'hugging-face') return 'huggingface';
  if (provider === 'llama-cpp' || provider === 'llamacpp' || provider === 'llama.cpp') return 'llama-cpp';
  if (provider === 'lmstudio' || provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  if (provider === 'mistral' || provider === 'mistral-ai') return 'mistral';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'perplexity') return 'perplexity';
  if (provider === 'together' || provider === 'togetherai' || provider === 'together-ai') return 'togetherai';
  if (provider === 'vercel' || provider === 'v0') return 'vercel';
  if (provider === 'xai' || provider === 'x-ai') return 'xai';
  return 'openrouter';
}

type LegacyModelConfigRecord = Partial<ModelConfigRecord> & {
  model?: string;
  apiKey?: string;
  baseURL?: string;
};

function modelApiKeyEnv(provider: ModelProvider) {
  return ({
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
  } as Record<ModelProvider, string>)[provider];
}

function modelBaseUrlEnv(provider: ModelProvider) {
  return ({
    'ai-gateway': 'AI_GATEWAY_BASE_URL',
    alibaba: 'ALIBABA_BASE_URL',
    anthropic: 'ANTHROPIC_BASE_URL',
    'azure-openai': 'AZURE_OPENAI_BASE_URL',
    bedrock: 'AWS_REGION',
    cerebras: 'CEREBRAS_BASE_URL',
    codex: '',
    cohere: 'COHERE_BASE_URL',
    deepinfra: 'DEEPINFRA_BASE_URL',
    deepseek: '',
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
  } as Record<ModelProvider, string>)[provider];
}

function defaultProviderSettings(provider: ModelProvider): ModelProviderSettings {
  return {
    model: defaultModelByProvider[provider],
    apiKey: '',
    baseURL: modelProviderDefinition(provider).defaultBaseURL || '',
  };
}

function normalizeStoredModelConfig(input?: LegacyModelConfigRecord): ModelConfigRecord | undefined {
  if (!input) return undefined;
  const provider = normalizeModelProvider(input.provider || 'openrouter');
  const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  const rawProviders = input.providers || {};

  for (const definition of modelProviderDefinitions) {
    const current = rawProviders[definition.value];
    providers[definition.value] = {
      ...defaultProviderSettings(definition.value),
      ...current,
      model: current?.model?.trim() || defaultModelByProvider[definition.value],
    };
  }

  if (input.model || input.apiKey || input.baseURL) {
    providers[provider] = {
      ...providers[provider],
      model: input.model?.trim() || providers[provider]?.model || defaultModelByProvider[provider],
      apiKey: input.apiKey ?? providers[provider]?.apiKey,
      baseURL: input.baseURL ?? providers[provider]?.baseURL,
    };
  }

  return {
    provider,
    providers,
    updatedAt: input.updatedAt || now(),
  };
}

function applyModelConfig(config?: LegacyModelConfigRecord) {
  const normalized = normalizeStoredModelConfig(config);
  if (!normalized) return;
  const provider = normalized.provider;
  const active = normalized.providers[provider] || defaultProviderSettings(provider);
  for (const definition of modelProviderDefinitions) {
    const item = normalized.providers[definition.value] || defaultProviderSettings(definition.value);
    const keyEnv = modelApiKeyEnv(definition.value);
    if (keyEnv) process.env[keyEnv] = item.apiKey || '';
    const baseUrlEnv = modelBaseUrlEnv(definition.value);
    if (baseUrlEnv) process.env[baseUrlEnv] = item.baseURL || definition.defaultBaseURL || '';
  }
  process.env.AI_PROVIDER = provider;
  process.env.AI_MODEL = active.model || defaultModelByProvider[provider];
}

function stepMemoryLine(step: StepExecutionResult) {
  const reasons = (step.tools || []).map((tool) => tool.reason).filter(Boolean).join('；');
  const tools = (step.tools || []).map((tool) => tool.name).filter(Boolean).join(',');
  const parts = [
    step.observation ? `观察：${compactText(step.observation, 100)}` : '',
    step.note ? `进展：${compactText(step.note, 100)}` : '',
    reasons ? `原因：${compactText(reasons, 140)}` : '',
    step.findings?.length ? `发现：${compactText(step.findings.join('；'), 140)}` : '',
    step.status === 'failed' || step.status === 'blocked' ? `异常：${compactText(step.actual, 160)}` : '',
  ].filter(Boolean);
  return `Step ${step.index} [${step.status}${tools ? `/${tools}` : ''}]: ${parts.join(' | ') || compactText(step.action || step.actual)}`;
}

function buildMemory(steps: StepExecutionResult[], previous?: NonNullable<NonNullable<TestRunRecord['result']>['memory']>) {
  const timeline = steps.map(stepMemoryLine).slice(-40);
  const ledgerSummaries = collectTaskLedgerItems(steps)
    .map((item) => compactText(`${item.status || 'finding'}:${item.title}${item.summary ? ` - ${item.summary}` : ''}`, 260))
    .filter(Boolean);
  const findings = Array.from(new Set([
    ...(previous?.findings || []),
    ...steps.flatMap((step) => step.findings || []),
    ...ledgerSummaries,
  ].map((item) => compactText(item, 260)).filter(Boolean))).slice(-40);
  const failedAttempts = Array.from(new Set([
    ...(previous?.failedAttempts || []),
    ...steps
      .filter((step) => step.status === 'failed' || step.status === 'blocked')
      .map((step) => `Step ${step.index}: ${compactText(step.action, 100)} -> ${compactText(step.actual, 220)}`),
  ])).slice(-20);
  const memoryItems = Array.from(new Set(steps.flatMap((step) => step.memoryItems || []).map((item) => compactText(item, 260)).filter(Boolean))).slice(-24);
  const summary = [
    `已执行 ${steps.length} 步。`,
    steps.length ? `最近进展：${steps.slice(-6).map((step) => `S${step.index}:${compactText(step.observation || step.note || step.action, 80)}`).join('；')}` : '',
    findings.length ? `重要发现：${findings.slice(-8).join('；')}` : '',
    memoryItems.length ? `后续记忆：${memoryItems.slice(-8).join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, 1800);
  return {
    summary,
    timeline,
    findings,
    failedAttempts,
    updatedAt: now(),
  };
}

// 原子写入本地 JSON 数据文件，避免运行中断时写出半截内容。
function taskLedgerKey(item: TaskLedgerItem) {
  return item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
}

function collectTaskFrame(steps: StepExecutionResult[]) {
  return steps.map((step) => step.taskFrame || step.workingMemory?.taskFrame).filter(Boolean).at(-1);
}

function collectTaskLedgerItems(steps: StepExecutionResult[]) {
  const map = new Map<string, TaskLedgerItem>();
  for (const item of [
    ...steps.flatMap((step) => step.ledgerItems || []),
    ...steps.flatMap((step) => step.workingMemory?.ledgerItems || []),
  ]) {
    map.set(taskLedgerKey(item), item);
  }
  return [...map.values()];
}

function isUserSkippedStep(step?: StepExecutionResult) {
  return Boolean(step?.status === 'blocked' && step.actual === 'User skipped this step manually.');
}

function writeData(data: StoreData) {
  writeJsonFileAtomic(storePath, data);
}

function normalizeSkillContent(content?: Partial<SkillContent>): SkillContent {
  return {
    whenToUse: (content?.whenToUse || []).map((item) => item.trim()).filter(Boolean).slice(0, 12),
    workflow: (content?.workflow || []).map((item) => item.trim()).filter(Boolean).slice(0, 18),
    reusablePatterns: (content?.reusablePatterns || []).map((item) => item.trim()).filter(Boolean).slice(0, 16),
    cautions: (content?.cautions || []).map((item) => item.trim()).filter(Boolean).slice(0, 12),
    verification: (content?.verification || []).map((item) => item.trim()).filter(Boolean).slice(0, 12),
    sourceSummary: content?.sourceSummary?.trim() || undefined,
  };
}

function normalizeSkillRecord(record: SkillRecord): SkillRecord {
  return {
    ...record,
    tags: (record.tags || []).map((item) => item.trim()).filter(Boolean).slice(0, 12),
    triggerPhrases: (record.triggerPhrases || []).map((item) => item.trim()).filter(Boolean).slice(0, 16),
    content: normalizeSkillContent(record.content),
    status: record.status || 'ready',
    version: record.version || 1,
  };
}

// 读取本地存储数据；文件不存在时初始化默认数据。
function readData(): StoreData {
  if (!existsSync(storePath)) {
    const seed: StoreData = { testCases: [seedRecord], runs: [], groups: [], skills: [], runtimeEnv: [], schedules: [] };
    writeData(seed);
    return seed;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreData;
      return {
        ...data,
        groups: data.groups || [],
        skills: (data.skills || []).map(normalizeSkillRecord),
        runtimeEnv: data.runtimeEnv || [],
        modelConfig: data.modelConfig,
        schedules: data.schedules || [],
      };
    } catch (error) {
      lastError = error;
      sleepSync(25);
    }
  }
  throw lastError;
}

export const store = {
  // 列出全部测试用例。
  listTestCases() {
    return readData().testCases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  // 列出全部测试分组。
  listGroups() {
    return readData().groups || [];
  },
  listSkills(query?: string) {
    const normalizedQuery = (query || '').trim().toLowerCase();
    const skills = (readData().skills || [])
      .map(normalizeSkillRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!normalizedQuery) return skills;
    return skills.filter((skill) => [
      skill.title,
      skill.description,
      ...skill.tags,
      ...skill.triggerPhrases,
    ].some((value) => value.toLowerCase().includes(normalizedQuery)));
  },
  getSkill(skillId: string) {
    const skill = (readData().skills || []).find((item) => item.id === skillId);
    return skill ? normalizeSkillRecord(skill) : undefined;
  },
  getSkills(skillIds: string[] = []) {
    const byId = new Map((readData().skills || []).map((skill) => [skill.id, normalizeSkillRecord(skill)]));
    return skillIds.map((skillId) => byId.get(skillId)).filter((item): item is SkillRecord => Boolean(item));
  },
  upsertSkill(input: {
    id?: string;
    title: string;
    description: string;
    tags?: string[];
    triggerPhrases?: string[];
    content: SkillContent;
    sourceRunId?: string;
    sourceTestCaseId?: string;
    sourceSessionId?: string;
    status?: SkillRecord['status'];
  }) {
    const data = readData();
    const timestamp = now();
    const existing = input.id ? (data.skills || []).find((item) => item.id === input.id) : undefined;
    const skill = normalizeSkillRecord({
      id: existing?.id || id('skl'),
      title: input.title.trim() || existing?.title || 'Runtime Skill',
      description: input.description.trim() || existing?.description || '',
      tags: input.tags || existing?.tags || [],
      triggerPhrases: input.triggerPhrases || existing?.triggerPhrases || [],
      content: normalizeSkillContent(input.content),
      sourceRunId: input.sourceRunId || existing?.sourceRunId,
      sourceTestCaseId: input.sourceTestCaseId || existing?.sourceTestCaseId,
      sourceSessionId: input.sourceSessionId || existing?.sourceSessionId,
      status: input.status || existing?.status || 'ready',
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    data.skills = existing
      ? (data.skills || []).map((item) => (item.id === skill.id ? skill : item))
      : [skill, ...(data.skills || [])];
    writeData(data);
    return skill;
  },
  deleteSkill(skillId: string) {
    const data = readData();
    const before = (data.skills || []).length;
    data.skills = (data.skills || []).filter((skill) => skill.id !== skillId);
    data.testCases = data.testCases.map((record) => (
      record.content.skillIds?.includes(skillId)
        ? { ...record, content: { ...record.content, skillIds: record.content.skillIds.filter((id) => id !== skillId) }, updatedAt: now() }
        : record
    ));
    writeData(data);
    return before !== data.skills.length;
  },
  // 列出保存到网页配置里的运行时环境变量。
  listRuntimeEnv() {
    return readData().runtimeEnv || [];
  },
  getModelConfig() {
    return normalizeStoredModelConfig(readData().modelConfig as LegacyModelConfigRecord | undefined);
  },
  saveModelConfig(input: Pick<ModelConfigRecord, 'provider' | 'providers'>) {
    const data = readData();
    const existing = normalizeStoredModelConfig(data.modelConfig as LegacyModelConfigRecord | undefined);
    const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
    const timestamp = now();

    for (const definition of modelProviderDefinitions) {
      const provider = definition.value;
      const current = input.providers[provider];
      const previous = existing?.providers[provider];
      providers[provider] = {
        ...defaultProviderSettings(provider),
        ...previous,
        ...current,
        model: current?.model?.trim() || previous?.model || defaultModelByProvider[provider],
        apiKey: current?.apiKey ?? previous?.apiKey ?? '',
        baseURL: current?.baseURL ?? previous?.baseURL ?? definition.defaultBaseURL ?? '',
        updatedAt: current ? timestamp : previous?.updatedAt,
      };
    }

    const config: ModelConfigRecord = {
      provider: normalizeModelProvider(input.provider),
      providers,
      updatedAt: timestamp,
    };
    data.modelConfig = config;
    writeData(data);
    applyModelConfig(config);
    return config;
  },
  // 保存网页配置的环境变量，服务端会在运行前加载 enabled=true 的配置。
  saveRuntimeEnv(items: Array<Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'>>) {
    const data = readData();
    data.runtimeEnv = items
      .filter((item) => item.key.trim())
      .map((item) => ({
        key: item.key.trim(),
        value: item.value,
        enabled: item.enabled,
        secret: item.secret,
        updatedAt: now(),
      }));
    writeData(data);
    return data.runtimeEnv;
  },
  // 把已启用的网页配置同步到当前 Node 进程。
  applyRuntimeEnv() {
    const allowedKeys = new Set(runtimeEnvKeys);
    const items = readData().runtimeEnv || [];
    const itemByKey = new Map(items.map((item) => [item.key, item]));
    const savedByKey = new Map(items.filter((item) => allowedKeys.has(item.key)).map((item) => [item.key, item]));
    const legacyTargetPrompt = itemByKey.get('AI_TARGET_MODE_CUSTOM_PROMPT')?.value?.trim();
    const legacyBrowserPrompt = itemByKey.get('AI_BROWSER_CHAT_CUSTOM_PROMPT')?.value?.trim();
    const legacyCustomSystemPrompt =
      itemByKey.get('AI_TARGET_MODE_CUSTOM_PROMPT_ENABLED')?.value === 'true' && legacyTargetPrompt
        ? legacyTargetPrompt
        : itemByKey.get('AI_BROWSER_CHAT_CUSTOM_PROMPT_ENABLED')?.value === 'true' && legacyBrowserPrompt
          ? legacyBrowserPrompt
          : '';
    for (const definition of runtimeEnvDefinitions) {
      const item = savedByKey.get(definition.key);
      if (item?.enabled === false) continue;
      process.env[definition.key] = item?.value ?? (definition.key === 'AI_CUSTOM_SYSTEM_PROMPT' ? legacyCustomSystemPrompt : definition.defaultValue);
    }
    applyModelConfig(readData().modelConfig as LegacyModelConfigRecord | undefined);
    return items;
  },
  // 列出定时回归任务。
  listSchedules() {
    return readData().schedules || [];
  },
  // 创建或更新定时回归任务。
  upsertSchedule(input: {
    id?: string;
    name: string;
    enabled: boolean;
    testCaseIds: string[];
    intervalMinutes: number;
    nextRunAt?: string;
  }) {
    const data = readData();
    const schedules = data.schedules || [];
    const existing = input.id ? schedules.find((item) => item.id === input.id) : undefined;
    const schedule: RunScheduleRecord = {
      id: existing?.id || id('sch'),
      name: input.name.trim() || '定时回归',
      enabled: input.enabled,
      testCaseIds: Array.from(new Set(input.testCaseIds)),
      intervalMinutes: Math.max(1, Math.floor(input.intervalMinutes || 60)),
      nextRunAt: input.nextRunAt || existing?.nextRunAt || new Date(Date.now() + Math.max(1, input.intervalMinutes || 60) * 60_000).toISOString(),
      lastRunAt: existing?.lastRunAt,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    data.schedules = existing
      ? schedules.map((item) => (item.id === schedule.id ? schedule : item))
      : [...schedules, schedule];
    writeData(data);
    return schedule;
  },
  // 删除定时回归任务。
  deleteSchedule(scheduleId: string) {
    const data = readData();
    data.schedules = (data.schedules || []).filter((item) => item.id !== scheduleId);
    writeData(data);
  },
  // 标记定时任务已经触发，并计算下一次运行时间。
  markScheduleTriggered(scheduleId: string) {
    const data = readData();
    let updated: RunScheduleRecord | undefined;
    data.schedules = (data.schedules || []).map((schedule) => {
      if (schedule.id !== scheduleId) return schedule;
      const base = Date.now();
      updated = {
        ...schedule,
        lastRunAt: now(),
        nextRunAt: new Date(base + schedule.intervalMinutes * 60_000).toISOString(),
        updatedAt: now(),
      };
      return updated;
    });
    writeData(data);
    return updated;
  },
  // 创建测试分组，并可挂到父分组下。
  createGroup(name: string, parentId?: string) {
    const data = readData();
    const group: TestGroupRecord = {
      id: id('grp'),
      parentId,
      name,
      createdAt: now(),
      updatedAt: now(),
    };
    data.groups = [...(data.groups || []), group];
    writeData(data);
    return group;
  },
  // 更新分组名称或父级关系。
  updateGroup(groupId: string, patch: Partial<Pick<TestGroupRecord, 'name' | 'parentId'>>) {
    const data = readData();
    let updated: TestGroupRecord | undefined;
    data.groups = (data.groups || []).map((group) => {
      if (group.id !== groupId) return group;
      updated = { ...group, ...patch, updatedAt: now() };
      return updated;
    });
    writeData(data);
    return updated;
  },
  // 根据 ID 获取单个测试用例。
  getTestCase(testCaseId: string) {
    return readData().testCases.find((item) => item.id === testCaseId);
  },
  // 获取指定测试用例的运行历史，并按开始时间倒序返回。
  listRunsForTestCase(testCaseId: string) {
    return readData().runs
      .filter((item) => item.testCaseId === testCaseId)
      .sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));
  },
  // 创建测试用例，同时保存关联图片和所属分组。
  createTestCase(content: TestCaseContent, imageNames: string[], groupId?: string) {
    const data = readData();
    const record: TestCaseRecord = {
      id: id('tc'),
      groupId,
      title: content.title,
      description: content.description,
      targetUrl: content.targetUrl,
      status: 'ready',
      priority: content.priority,
      content,
      imageNames,
      createdAt: now(),
      updatedAt: now(),
    };
    data.testCases.push(record);
    writeData(data);
    return record;
  },
  // 删除一条执行记录。这里只移除历史元数据，artifact 文件保留，避免误删仍被报告引用的证据。
  deleteRun(runId: string) {
    return this.deleteRuns([runId]) > 0;
  },
  deleteRuns(runIds: string[]) {
    const targetIds = new Set(runIds.filter(Boolean));
    if (!targetIds.size) return 0;
    const data = readData();
    const before = data.runs.length;
    const deletedRunIds = data.runs.filter((run) => targetIds.has(run.id)).map((run) => run.id);
    data.runs = data.runs.filter((run) => !targetIds.has(run.id));
    data.testCases = data.testCases.map((record) => (
      record.content.defaultRecordedRunId && targetIds.has(record.content.defaultRecordedRunId)
        ? { ...record, content: { ...record.content, defaultRecordedRunId: undefined }, updatedAt: now() }
        : record
    ));
    writeData(data);
    notifyRunsDeleted(deletedRunIds);
    return before - data.runs.length;
  },
  // 删除测试用例，并移除关联运行记录与定时任务引用。artifact 文件保留，避免误删仍需追溯的证据。
  deleteTestCase(testCaseId: string) {
    const data = readData();
    const exists = data.testCases.some((record) => record.id === testCaseId);
    if (!exists) return false;
    const deletedRunIds = data.runs.filter((run) => run.testCaseId === testCaseId).map((run) => run.id);
    data.testCases = data.testCases.filter((record) => record.id !== testCaseId);
    data.runs = data.runs.filter((run) => run.testCaseId !== testCaseId);
    data.schedules = (data.schedules || [])
      .map((schedule) => ({
        ...schedule,
        testCaseIds: schedule.testCaseIds.filter((id) => id !== testCaseId),
        updatedAt: now(),
      }))
      .filter((schedule) => schedule.testCaseIds.length > 0);
    writeData(data);
    notifyRunsDeleted(deletedRunIds);
    return true;
  },
  // 更新测试用例的整体执行状态。
  updateTestCaseStatus(testCaseId: string, status: TestCaseRecord['status']) {
    const data = readData();
    data.testCases = data.testCases.map((record) =>
      record.id === testCaseId ? { ...record, status, updatedAt: now() } : record,
    );
    writeData(data);
  },
  // 移动测试用例到指定分组，未传分组则移出分组。
  moveTestCase(testCaseId: string, groupId?: string) {
    const data = readData();
    let updated: TestCaseRecord | undefined;
    data.testCases = data.testCases.map((record) => {
      if (record.id !== testCaseId) return record;
      updated = { ...record, groupId, updatedAt: now() };
      return updated;
    });
    writeData(data);
    return updated;
  },
  // 更新测试用例内容和可选图片列表。
  updateTestCase(testCaseId: string, content: TestCaseContent, imageNames?: string[]) {
    const data = readData();
    let updated: TestCaseRecord | undefined;
    data.testCases = data.testCases.map((record) => {
      if (record.id !== testCaseId) return record;
      updated = {
        ...record,
        title: content.title,
        description: content.description,
        targetUrl: content.targetUrl,
        priority: content.priority,
        content,
        imageNames: imageNames ?? record.imageNames,
        updatedAt: now(),
      };
      return updated;
    });
    writeData(data);
    return updated;
  },
  // 为测试用例创建一条新的运行记录。
  createRun(testCaseId: string) {
    const data = readData();
    const run: TestRunRecord = {
      id: id('run'),
      testCaseId,
      status: 'queued',
      createdAt: now(),
    };
    data.runs.push(run);
    writeData(data);
    notifyRunUpdate(run.id, run);
    return run;
  },
  // 更新运行记录的队列元信息。
  updateRunQueue(runId: string, queue: TestRunRecord['queue']) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = { ...run, queue };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 合并历史失败沉淀出的操作策略，后续运行会进入 AI prompt。
  appendTestCaseStrategyMemory(testCaseId: string, hints: string[]) {
    const cleanHints = hints.map((hint) => hint.trim()).filter(Boolean);
    if (!cleanHints.length) return this.getTestCase(testCaseId);
    const data = readData();
    let updated: TestCaseRecord | undefined;
    data.testCases = data.testCases.map((record) => {
      if (record.id !== testCaseId) return record;
      const memory = Array.from(new Set([...(record.strategyMemory || []), ...cleanHints])).slice(-12);
      updated = { ...record, strategyMemory: memory, updatedAt: now() };
      return updated;
    });
    writeData(data);
    return updated;
  },
  // 局部更新运行记录，并自动刷新更新时间。
  updateRun(runId: string, patch: Partial<TestRunRecord>) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = { ...run, ...patch };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 新增或替换运行步骤结果，保证相同步骤号只保留最新记录。
  updateRunStep(runId: string, step: StepExecutionResult) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;

    const result = run.result || { steps: [], consoleErrors: [], networkErrors: [] };
    const existingStep = result.steps.find((item) => item.index === step.index);
    if (isUserSkippedStep(existingStep) && !isUserSkippedStep(step)) {
      return run;
    }
    const exists = result.steps.some((item) => item.index === step.index);
    const steps = exists
      ? result.steps.map((item) => (item.index === step.index ? { ...item, ...step } : item))
      : [...result.steps, step].sort((a, b) => a.index - b.index);

    const updated = {
      ...run,
      result: {
        ...result,
        steps,
        taskFrame: collectTaskFrame(steps),
        ledgerItems: collectTaskLedgerItems(steps),
        memory: buildMemory(steps, result.memory),
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 追加运行调试事件，最多保留最近 200 条。
  appendRunDebug(runId: string, event: Omit<RunDebugEvent, 'time'>) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const debug = run.debug || { enabled: false, phase: '', events: [] };
    const updatedDebug = {
      ...debug,
      phase: event.phase,
      stepIndex: event.stepIndex,
      events: [...debug.events, { ...event, time: now() }].slice(-200),
    };
    const updated = { ...run, debug: updatedDebug };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 请求跳过指定步骤或当前步骤，并中断正在进行的 AI 请求。
  requestRunSkip(runId: string, stepIndex?: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = {
      ...run,
      control: {
        ...run.control,
        skipRequestedAt: now(),
        skipStepIndex: stepIndex,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 请求暂停运行，并中断当前步骤让执行循环进入暂停态。
  requestRunPause(runId: string, stepIndex?: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const pausedAt = now();
    const updated = {
      ...run,
      status: 'paused' as const,
      control: {
        ...run.control,
        pauseRequestedAt: pausedAt,
        pauseStepIndex: stepIndex,
        pausedAt,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 请求恢复运行；如果指定步骤则只恢复该步骤。
  requestRunResume(runId: string, stepIndex?: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = {
      ...run,
      status: run.status === 'paused' ? ('running' as const) : run.status,
      control: {
        ...run.control,
        pauseRequestedAt: undefined,
        pauseStepIndex: undefined,
        pausedAt: undefined,
        resumeRequestedAt: now(),
        resumeStepIndex: stepIndex,
        manualIntervention: undefined,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 判断运行是否处于暂停状态。
  isRunPaused(runId: string) {
    const run = readData().runs.find((item) => item.id === runId);
    return Boolean(run?.control?.pausedAt);
  },
  // 设置或清除人工介入状态，例如等待用户输入验证码。
  setRunManualIntervention(runId: string, manualIntervention?: NonNullable<TestRunRecord['control']>['manualIntervention']) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    if (!run) return undefined;
    const updated = {
      ...run,
      control: {
        ...run.control,
        manualIntervention,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return updated;
  },
  // 消费一次跳过请求；消费后会从控制状态中移除，避免重复跳过。
  consumeRunSkip(runId: string, stepIndex: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    const requested = run?.control?.skipRequestedAt && (!run.control.skipStepIndex || run.control.skipStepIndex === stepIndex);
    if (!run || !requested) return false;
    const updated = { ...run, control: { ...run.control, skipRequestedAt: undefined, skipStepIndex: undefined } };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return true;
  },
  // 消费一次恢复请求；消费后清理恢复标记。
  consumeRunResume(runId: string, stepIndex: number) {
    const data = readData();
    const run = data.runs.find((item) => item.id === runId);
    const requested = run?.control?.resumeRequestedAt && (!run.control.resumeStepIndex || run.control.resumeStepIndex === stepIndex);
    if (!run || !requested) return false;
    const updated = {
      ...run,
      control: {
        ...run.control,
        resumeRequestedAt: undefined,
        resumeStepIndex: undefined,
        manualIntervention: undefined,
      },
    };
    data.runs = data.runs.map((item) => (item.id === runId ? updated : item));
    writeData(data);
    notifyRunUpdate(runId, updated);
    return true;
  },
  // 根据 ID 获取单条运行记录。
  getRun(runId: string) {
    return readData().runs.find((item) => item.id === runId);
  },
};
