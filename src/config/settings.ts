import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';
import { normalizedModelCapabilities } from '@/lib/model-capabilities';
import { browserCapabilitySettings } from '@webpilot/capability-browser/settings';
import { chartCapabilitySettings } from '@webpilot/capability-chart/settings';
import { codeSandboxCapabilitySettings } from '@webpilot/capability-code-sandbox/settings';
import { communicationCapabilitySettings } from '@webpilot/capability-communication/settings';
import { computerCapabilitySettings } from '@webpilot/capability-computer/settings';
import { connectorsCapabilitySettings } from '@webpilot/capability-connectors/settings';
import { dataCapabilitySettings } from '@webpilot/capability-data/settings';
import { fileCapabilitySettings } from '@webpilot/capability-file/settings';
import { gitCapabilitySettings } from '@webpilot/capability-git/settings';
import { knowledgeCapabilitySettings } from '@webpilot/capability-knowledge/settings';
import { mediaCapabilitySettings } from '@webpilot/capability-media/settings';
import { researchCapabilitySettings } from '@webpilot/capability-research/settings';
import { workflowCapabilitySettings } from '@webpilot/capability-workflow/settings';
import {
  defaultGlinerOpenLabelModel,
  defaultLiquidPiiModel,
} from '@webpilot/capability-sensitive-data';
import { sensitiveDataCapabilitySettings } from '@webpilot/capability-sensitive-data/settings';
import { normalizeBoundedNumberSetting, type CapabilitySettingDefinition } from '@webpilot/capability-sdk';

export { defaultGlinerOpenLabelModel, defaultLiquidPiiModel };

export type SettingsTab = 'general' | 'model' | 'runtime' | 'browser' | 'capabilities' | 'integrations' | 'sensitive-data' | 'skills' | 'memory' | 'accounts' | 'debug';

export type ModelProviderDefinition = {
  value: ModelProvider;
  label: string;
  defaultModel: string;
  defaultModels?: string[];
  keyLabel: string;
  baseUrlLabel?: string;
  defaultBaseURL?: string;
  localAuth?: boolean;
};

export type ModelSettingsLike = {
  defaultModel?: string;
  model?: string;
  models?: string[];
};

export type RuntimeEnvDefinition = {
  key: string;
  label: string;
  description: string;
  tab: Exclude<SettingsTab, 'general' | 'model' | 'skills' | 'memory' | 'accounts'>;
  defaultValue: string;
  control: 'boolean' | 'number' | 'select' | 'text' | 'secret' | 'textarea';
  min?: number;
  max?: number;
  step?: number;
  group?: string;
  applyMode?: 'runtime' | 'startup';
  options?: ReadonlyArray<{ label: string; value: string }>;
  picker?: 'directory';
  secret?: boolean;
  hidden?: boolean;
  emptyUsesDefault?: boolean;
  valueAliases?: Readonly<Record<string, string>>;
};

const capabilitySettingDefinitions: readonly CapabilitySettingDefinition[] = [
  ...browserCapabilitySettings,
  ...chartCapabilitySettings,
  ...fileCapabilitySettings,
  ...codeSandboxCapabilitySettings,
  ...researchCapabilitySettings,
  ...connectorsCapabilitySettings,
  ...knowledgeCapabilitySettings,
  ...dataCapabilitySettings,
  ...mediaCapabilitySettings,
  ...communicationCapabilitySettings,
  ...gitCapabilitySettings,
  ...computerCapabilitySettings,
  ...workflowCapabilitySettings,
  ...sensitiveDataCapabilitySettings,
];

const capabilityRuntimeEnvDefinitions: RuntimeEnvDefinition[] = capabilitySettingDefinitions.map((definition) => ({
  ...definition,
  tab: definition.section as RuntimeEnvDefinition['tab'],
}));

export function migrateRuntimeEnvValue(key: string, value: string) {
  const definition = capabilitySettingDefinitions.find((item) => item.key === key);
  const normalized = definition?.emptyUsesDefault && !value.trim() ? definition.defaultValue : value;
  return definition?.valueAliases?.[normalized] ?? normalized;
}

export function normalizeMiniMaxOpenAIBaseURL(baseURL: string | undefined) {
  const officialAnthropicEndpoint = baseURL?.trim().match(
    /^(https:\/\/api\.(?:minimax\.io|minimaxi\.com))\/anthropic(?:\/v1)?\/?$/i,
  );
  return officialAnthropicEndpoint
    ? `${officialAnthropicEndpoint[1]}/v1`
    : baseURL;
}

export const modelProviderDefinitions: ModelProviderDefinition[] = [
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5', keyLabel: 'OpenAI 访问密钥', baseUrlLabel: 'OpenAI 服务地址' },
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容接口',
    defaultModel: 'custom-model',
    keyLabel: '兼容接口访问密钥',
    baseUrlLabel: '兼容接口 Base URL',
  },
  { value: 'openrouter', label: 'OpenRouter', defaultModel: 'qwen/qwen3.6-27b', keyLabel: 'OpenRouter 访问密钥' },
  { value: 'ollama', label: 'Ollama', defaultModel: 'llama3.1', keyLabel: 'Ollama 访问密钥（可选）', baseUrlLabel: 'Ollama 服务地址', defaultBaseURL: 'http://localhost:11434/v1' },
  { value: 'llama-cpp', label: 'llama.cpp', defaultModel: 'local-model', keyLabel: 'llama.cpp 访问密钥（可选）', baseUrlLabel: 'llama.cpp 服务地址', defaultBaseURL: 'http://localhost:8080/v1' },
  {
    value: 'lmstudio',
    label: 'LM Studio',
    defaultModel: 'qwen3-vl-2b-instruct',
    keyLabel: 'LM Studio 访问密钥（可选）',
    baseUrlLabel: 'LM Studio 服务地址',
    defaultBaseURL: 'http://localhost:1234/v1',
  },
  { value: 'google', label: 'Google Gemini API', defaultModel: 'gemini-3-flash-preview', keyLabel: 'Google 访问密钥' },
  { value: 'codex', label: 'Codex CLI', defaultModel: 'gpt-5.5', keyLabel: 'Codex CLI 使用本地登录，无需 Key', localAuth: true },
  { value: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-5', keyLabel: 'Anthropic 访问密钥', baseUrlLabel: 'Anthropic 服务地址' },
  {
    value: 'minimax',
    label: 'MiniMax',
    defaultModel: 'minimax-m3',
    defaultModels: [
      'minimax-m3',
      'minimax-m2.7',
      'minimax-m2.7-highspeed',
      'minimax-m2.5',
      'minimax-m2.5-highspeed',
      'minimax-m2.1',
      'minimax-m2.1-highspeed',
      'minimax-m2',
    ],
    keyLabel: 'MiniMax 访问密钥',
    baseUrlLabel: 'MiniMax 服务地址',
    defaultBaseURL: 'https://api.minimax.io/v1',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    keyLabel: 'DeepSeek 访问密钥',
    baseUrlLabel: 'DeepSeek 服务地址',
    defaultBaseURL: 'https://api.deepseek.com',
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    defaultModel: 'gpt-5.5',
    keyLabel: 'Azure OpenAI 访问密钥',
    baseUrlLabel: 'Azure OpenAI 服务地址',
    defaultBaseURL: 'http://mirrors.shterm.com:8801/openai',
  },
  { value: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile', keyLabel: 'Groq 访问密钥', baseUrlLabel: 'Groq 服务地址' },
  { value: 'xai', label: 'xAI', defaultModel: 'grok-4', keyLabel: 'xAI 访问密钥', baseUrlLabel: 'xAI 服务地址' },
  { value: 'mistral', label: 'Mistral AI', defaultModel: 'mistral-large-latest', keyLabel: 'Mistral 访问密钥', baseUrlLabel: 'Mistral 服务地址' },
  { value: 'alibaba', label: 'Alibaba Cloud', defaultModel: 'qwen-plus', keyLabel: 'Alibaba 访问密钥', baseUrlLabel: 'Alibaba 服务地址' },
  { value: 'ai-gateway', label: 'Vercel AI Gateway', defaultModel: 'openai/gpt-5.5', keyLabel: 'AI Gateway 访问密钥', baseUrlLabel: 'AI Gateway 服务地址' },
  { value: 'perplexity', label: 'Perplexity', defaultModel: 'sonar', keyLabel: 'Perplexity 访问密钥', baseUrlLabel: 'Perplexity 服务地址' },
  { value: 'cohere', label: 'Cohere', defaultModel: 'command-a-03-2025', keyLabel: 'Cohere 访问密钥', baseUrlLabel: 'Cohere 服务地址' },
  { value: 'togetherai', label: 'Together.ai', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyLabel: 'Together.ai 访问密钥', baseUrlLabel: 'Together.ai 服务地址' },
  { value: 'fireworks', label: 'Fireworks AI', defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct', keyLabel: 'Fireworks 访问密钥', baseUrlLabel: 'Fireworks 服务地址' },
  { value: 'deepinfra', label: 'DeepInfra', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct', keyLabel: 'DeepInfra 访问密钥', baseUrlLabel: 'DeepInfra 服务地址' },
  { value: 'cerebras', label: 'Cerebras', defaultModel: 'llama3.1-8b', keyLabel: 'Cerebras 访问密钥', baseUrlLabel: 'Cerebras 服务地址' },
  { value: 'huggingface', label: 'Hugging Face', defaultModel: 'meta-llama/Llama-3.1-8B-Instruct', keyLabel: 'Hugging Face 访问密钥', baseUrlLabel: 'Hugging Face 服务地址' },
  { value: 'bedrock', label: 'Amazon Bedrock', defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0', keyLabel: 'AWS Bedrock Bearer Token（可选）', baseUrlLabel: 'AWS 区域', defaultBaseURL: 'us-east-1' },
  { value: 'vercel', label: 'Vercel v0', defaultModel: 'v0-1.5-md', keyLabel: 'Vercel 访问密钥', baseUrlLabel: 'Vercel 服务地址' },
  {
    value: 'openai-compatible-2',
    label: 'OpenAI Compatible 2',
    defaultModel: 'custom-model',
    keyLabel: 'Compatible API 2 Key',
    baseUrlLabel: 'Compatible API 2 Base URL',
  },
  {
    value: 'openai-compatible-3',
    label: 'OpenAI Compatible 3',
    defaultModel: 'custom-model',
    keyLabel: 'Compatible API 3 Key',
    baseUrlLabel: 'Compatible API 3 Base URL',
  },
];

export const modelProviderValues = modelProviderDefinitions.map((item) => item.value);

export type OpenAICompatibleModelProvider = 'openai-compatible' | `openai-compatible-${number}`;

export function openAICompatibleProviderIndex(value: unknown) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'openai-compatible') return 1;
  const match = provider.match(/^openai-compatible-(\d+)$/);
  if (!match) return undefined;
  const index = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(index) && index >= 2 ? index : undefined;
}

export function isOpenAICompatibleProvider(value: unknown): value is OpenAICompatibleModelProvider {
  return typeof value === 'string'
    && value === value.trim().toLowerCase()
    && openAICompatibleProviderIndex(value) !== undefined;
}

export function isModelProvider(value: unknown): value is ModelProvider {
  if (typeof value !== 'string' || value !== value.trim().toLowerCase()) return false;
  const provider = String(value || '').trim().toLowerCase();
  return modelProviderDefinitions.some((item) => item.value === provider)
    || isOpenAICompatibleProvider(provider);
}

export function modelProviderDefinitionsForConfig(providers?: object | null) {
  const known = new Set(modelProviderDefinitions.map((definition) => definition.value));
  const custom = Object.keys(providers || {})
    .filter((provider): provider is ModelProvider => isOpenAICompatibleProvider(provider) && !known.has(provider))
    .sort((left, right) => (
      (openAICompatibleProviderIndex(left) || 0) - (openAICompatibleProviderIndex(right) || 0)
    ));
  return [
    ...modelProviderDefinitions,
    ...custom.map((provider) => modelProviderDefinition(provider)),
  ];
}

export const defaultModelByProvider = modelProviderDefinitions.reduce((acc, item) => {
  acc[item.value] = item.defaultModel;
  return acc;
}, {} as Record<ModelProvider, string>);

export function modelProviderDefinition(provider: ModelProvider) {
  const existing = modelProviderDefinitions.find((item) => item.value === provider);
  if (existing) return existing;
  const compatibleIndex = openAICompatibleProviderIndex(provider);
  if (compatibleIndex) {
    return {
      value: provider,
      label: `OpenAI Compatible ${compatibleIndex}`,
      defaultModel: 'custom-model',
      keyLabel: `Compatible API ${compatibleIndex} Key`,
      baseUrlLabel: `Compatible API ${compatibleIndex} Base URL`,
    } satisfies ModelProviderDefinition;
  }
  return modelProviderDefinitions[0];
}

export function uniqueModelIds(values: Array<string | undefined | null>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const model = String(value || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

export function modelListForProvider(definition: ModelProviderDefinition, settings?: ModelSettingsLike) {
  return uniqueModelIds([
    ...(settings?.models || []),
    settings?.defaultModel,
    settings?.model,
  ]).filter((model) => !(
    definition.value.startsWith('openai-compatible')
    && model === 'custom-model'
  ));
}

export function defaultModelForProvider(definition: ModelProviderDefinition, settings?: ModelSettingsLike) {
  const models = modelListForProvider(definition, settings);
  const requested = String(settings?.defaultModel || settings?.model || '').trim();
  return requested && models.includes(requested) ? requested : models[0] || '';
}

export function defaultModelProviderSettings(provider: ModelProvider): ModelProviderSettings {
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

const boolOptions = [
  { label: '开启', value: 'true' },
  { label: '关闭', value: 'false' },
];

const applicationRuntimeEnvDefinitions: RuntimeEnvDefinition[] = [

  { key: 'SQLITE_AUTO_COMPACT_ENABLED', label: 'SQLite 自动压缩', description: '维护任务发现大量空闲页时执行 WAL checkpoint 和 VACUUM，减少数据库及备份体积。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'SQLITE_COMPACTION_FREE_RATIO', label: 'SQLite 压缩空闲比例', description: '空闲页达到该比例且超过最小页数时执行压缩；默认 0.3。', tab: 'runtime', defaultValue: '0.3', control: 'number', min: 0.1, max: 0.9, step: 0.05 },
  { key: 'SQLITE_COMPACTION_MIN_FREE_PAGES', label: 'SQLite 压缩最小空闲页', description: '达到该空闲页数后才允许执行 VACUUM，避免小数据库频繁重写。', tab: 'runtime', defaultValue: '1024', control: 'number', min: 128, max: 100000, step: 128 },
  { key: 'AI_CUSTOM_SYSTEM_PROMPT', label: '附加系统规则', description: '追加到内置 Agent Loop 运行提示词末尾的用户规则；不会替换、覆盖或削弱原有提示词。', tab: 'runtime', defaultValue: '', control: 'textarea' },
  { key: 'AI_REQUEST_TIMEOUT_MS', label: 'AI 请求超时', description: '单次模型请求首个响应及普通非流式调用的最长等待时间。', tab: 'runtime', defaultValue: '120000', control: 'number' },
  { key: 'AI_RUNTIME_REQUEST_TIMEOUT_MS', label: 'Agent 模型请求超时', description: 'Agent Loop 单轮模型请求的最长等待时间；大上下文或长推理模型可能需要数分钟，默认 600000 毫秒。', tab: 'runtime', defaultValue: '600000', control: 'number' },
  { key: 'AI_STREAM_FIRST_CHUNK_TIMEOUT_MS', label: 'AI 首块响应超时', description: '等待首个有效内容块的最长时间（毫秒）；Agent 请求包含等待响应头的时间，独立于较长的轮次和工具超时，不会被自动抬高。留空时跟随请求超时。', tab: 'runtime', defaultValue: '120000', control: 'number' },
  { key: 'AI_STREAM_CHUNK_TIMEOUT_MS', label: 'AI 流式分块超时', description: '流式响应相邻内容块之间允许的最长等待时间；Agent 工具循环会自动为工具执行预留完整时间。', tab: 'runtime', defaultValue: '120000', control: 'number' },
  { key: 'AI_TOOL_TIMEOUT_MS', label: 'AI 工具执行超时', description: '单次 AI 工具执行的默认最长时间；模型请求与工具执行分别计时。', tab: 'runtime', defaultValue: '120000', control: 'number' },
  { key: 'AI_REASONING_EFFORT', label: 'AI 推理强度', description: '统一控制支持该能力的模型推理强度；默认由提供商决定。', tab: 'runtime', defaultValue: 'provider-default', control: 'select', options: [{ label: '提供商默认', value: 'provider-default' }, { label: '无', value: 'none' }, { label: '极低', value: 'minimal' }, { label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }, { label: '极高', value: 'xhigh' }] },
  { key: 'AI_TELEMETRY_ENABLED', label: 'AI 运行指标', description: '记录模型耗时、首块延迟、Token 用量和工具耗时；不会记录提示词、输出或工具参数。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_SUBAGENT_LOOP_TIMEOUT_MS', label: '子 Agent 执行超时', description: '单个并行子 Agent 的完整工具循环最长时间；默认 600000 毫秒，不限制工具回合数。', tab: 'runtime', defaultValue: '600000', control: 'number' },
  { key: 'AI_SUBAGENT_CONCURRENCY', label: '子 Agent 全局并发数', description: '整个服务同时运行的子 Agent 数量，可配置为任意正整数；默认 20。超过配置值的任务排队。', tab: 'runtime', defaultValue: '20', control: 'number', min: 1, step: 1 },
  { key: 'AI_SUBAGENT_RESULT_MAX_CHARS', label: '子 Agent 总结建议长度', description: '写入子 Agent 提示词的建议最大字符数；只引导模型控制篇幅，后端不会截断实际结果。', tab: 'runtime', defaultValue: '40000', control: 'number' },
  { key: 'AI_RUNTIME_REQUEST_RETRY_ATTEMPTS', label: 'AI 请求连续失败上限', description: 'Agent Loop 中上游连接或请求级错误连续失败达到该次数后停止；成功一次会清零。', tab: 'runtime', defaultValue: '3', control: 'number' },
  { key: 'AI_PERSONAL_MEMORY_ENABLED', label: '个性化记忆召回', description: '是否在浏览器对话提示词中召回简洁的用户记忆和域名记忆。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_PERSONAL_MEMORY_EXTRACT_ENABLED', label: '个性化记忆提炼', description: '每轮浏览器对话完成后，是否提炼可长期复用的别名、偏好、工作流和域名事实。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_PERSONAL_MEMORY_PROMPT_LIMIT', label: '个性化记忆注入上限', description: '单轮浏览器对话最多注入多少条个性化记忆。', tab: 'runtime', defaultValue: '6', control: 'number' },
  { key: 'AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS', label: '个性化记忆注入字符预算', description: '单轮注入提示词的记忆字符预算，只限制本次 AI 上下文，不截断数据库保存的原文。', tab: 'runtime', defaultValue: '12000', control: 'number', min: 1000, max: 120000, step: 1000 },
  { key: 'AI_PERSONAL_MEMORY_EXTRACTION_CONCURRENCY', label: '记忆提取并发数', description: '不同用户可并发提取记忆的全局上限；同一用户始终串行，避免并发写入相互覆盖。', tab: 'runtime', defaultValue: '2', control: 'number', min: 1, max: 8, step: 1 },
  { key: 'AI_PERSONAL_MEMORY_EXTRACTION_QUEUE_LIMIT', label: '记忆提取队列上限', description: '等待提取的对话轮次上限；同一会话轮次会自动去重。', tab: 'runtime', defaultValue: '100', control: 'number', min: 10, max: 1000, step: 10 },
  { key: 'AI_CONTEXT_WINDOW_TOKENS', label: '上下文窗口大小', description: '估算模型上下文窗口大小。', tab: 'runtime', defaultValue: '256000', control: 'number' },
  { key: 'AI_GLM_CONTEXT_WINDOW_TOKENS', label: 'GLM 上下文窗口大小', description: 'GLM 模型使用的上下文窗口估算值；默认 1000000，覆盖通用上下文窗口配置。', tab: 'runtime', defaultValue: '1000000', control: 'number' },
  { key: 'AI_IMAGE_CONTEXT_ESTIMATE_TOKENS', label: '单张图片估算 Token', description: '估算每张截图占用的上下文 token。', tab: 'runtime', defaultValue: '1200', control: 'number' },

  { key: 'CODEX_PATH', label: 'Codex CLI 路径', description: '自定义 Codex CLI 可执行文件路径。', tab: 'debug', defaultValue: '', control: 'text' },
  { key: 'CODEX_CWD', label: 'Codex 工作目录', description: 'Codex CLI 默认工作目录。', tab: 'debug', defaultValue: '', control: 'text' },
  { key: 'CODEX_APPROVAL_MODE', label: 'Codex 审批模式', description: 'Codex CLI 的审批策略。', tab: 'debug', defaultValue: 'on-request', control: 'select', options: [{ label: '按需询问', value: 'on-request' }, { label: '永不询问', value: 'never' }, { label: '不受信任时询问', value: 'untrusted' }] },
  { key: 'CODEX_SANDBOX_MODE', label: 'Codex 沙箱模式', description: 'Codex CLI 的文件系统沙箱模式。', tab: 'debug', defaultValue: 'workspace-write', control: 'select', options: [{ label: '工作区可写', value: 'workspace-write' }, { label: '只读', value: 'read-only' }, { label: '完全访问', value: 'danger-full-access' }] },
  { key: 'CODEX_VERBOSE', label: 'Codex 详细日志', description: '是否输出更详细的 Codex 日志。', tab: 'debug', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'CODEX_SKIP_GIT_REPO_CHECK', label: '跳过 Git 仓库检查', description: 'Codex CLI 是否跳过 Git 仓库检查。', tab: 'debug', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'CODEX_ALLOW_NPX', label: '允许 Codex 使用 npx', description: 'Codex CLI 是否允许 npx。', tab: 'debug', defaultValue: 'false', control: 'boolean', options: boolOptions },
];

export const runtimeEnvDefinitions: RuntimeEnvDefinition[] = [
  ...applicationRuntimeEnvDefinitions,
  ...capabilityRuntimeEnvDefinitions,
];

export const runtimeEnvKeys = runtimeEnvDefinitions.map((item) => item.key);

export function normalizeRuntimeEnvValue(definition: RuntimeEnvDefinition, value: string) {
  const migratedValue = migrateRuntimeEnvValue(definition.key, value);
  if (definition.control !== 'number' || (definition.min === undefined && definition.max === undefined)) return migratedValue;
  return normalizeBoundedNumberSetting({
    value: migratedValue,
    defaultValue: definition.defaultValue,
    min: definition.min,
    max: definition.max,
    step: definition.step,
  });
}

export function runtimeEnvDefinition(key: string) {
  return runtimeEnvDefinitions.find((item) => item.key === key);
}
