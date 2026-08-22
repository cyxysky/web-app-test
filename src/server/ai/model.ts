import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { generateText } from 'ai';
import { normalizeMiniMaxOpenAIBaseURL } from '@/config/settings';
import { ensureAiSdkTelemetryRegistered } from '@/server/ai/ai-sdk-telemetry';

ensureAiSdkTelemetryRegistered();

type GenerateTextModel = Parameters<typeof generateText>[0]['model'];
type LoadedLanguageModel = LanguageModelV4;
type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type AiProvider =
  | 'ai-gateway'
  | 'alibaba'
  | 'anthropic'
  | 'azure-openai'
  | 'bedrock'
  | 'cerebras'
  | 'codex'
  | 'cohere'
  | 'deepinfra'
  | 'deepseek'
  | 'fireworks'
  | 'google'
  | 'groq'
  | 'huggingface'
  | 'llama-cpp'
  | 'lmstudio'
  | 'minimax'
  | 'mistral'
  | 'ollama'
  | 'openai'
  | 'openai-compatible'
  | 'openai-compatible-2'
  | 'openai-compatible-3'
  | 'openrouter'
  | 'perplexity'
  | 'togetherai'
  | 'vercel'
  | 'xai';
type ApprovalMode = 'never' | 'on-request' | 'untrusted';
type SandboxMode = 'danger-full-access' | 'read-only' | 'workspace-write';
export type ModelSettingsOverride = {
  provider?: string;
  model?: string;
  supportsImageInput?: boolean;
};

const modelSettingsStorage = new AsyncLocalStorage<ModelSettingsOverride>();

function resolveCodexCliPath(configuredPath: string | undefined, projectRoot: string) {
  const value = String(configuredPath || '').trim();
  if (value) {
    const expandedPath = value.replace(/^\[project\](?=$|[\\/])/i, projectRoot);
    if (expandedPath !== value || path.isAbsolute(expandedPath)) {
      return path.normalize(expandedPath);
    }
    if (expandedPath.startsWith('.') || /[\\/]/.test(expandedPath)) {
      return path.resolve(projectRoot, expandedPath);
    }
    return expandedPath;
  }

  // Next.js can rewrite createRequire(import.meta.url).resolve() inside the
  // provider to a literal "[project]" path. Supplying the optional local CLI
  // entry explicitly bypasses that bundled resolver while retaining the PATH
  // fallback when the optional dependency is not installed.
  const localCliPath = path.join(
    projectRoot,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  return existsSync(localCliPath) ? localCliPath : undefined;
}

function optionalEnvironmentValue(name: string) {
  const value = String(process.env[name] || '').trim();
  if (value) return value;
  // AI SDK 7 provider entrypoints validate their own base URL environment
  // variable while the package is imported. An empty persisted setting means
  // "use the provider default", so it must be absent rather than an empty
  // string before the lazy import runs.
  delete process.env[name];
  return undefined;
}

function miniMaxOpenAIBaseURL() {
  return normalizeMiniMaxOpenAIBaseURL(
    optionalEnvironmentValue('MINIMAX_BASE_URL'),
  );
}

const protectedOpenAICompatibleRequestFields = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
]);

function extraOpenAICompatibleRequestParameters(environmentName: string) {
  const raw = String(process.env[environmentName] || '').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => !protectedOpenAICompatibleRequestFields.has(key)));
  } catch {
    return {};
  }
}

function mergeExtraOpenAICompatibleRequestParameters(
  body: Record<string, unknown>,
  parameters: Record<string, unknown>,
) {
  return { ...body, ...parameters };
}

function lazyLanguageModel(
  provider: string,
  modelId: string,
  loader: () => Promise<LoadedLanguageModel>,
): GenerateTextModel {
  let resolvedModel: Promise<LoadedLanguageModel> | undefined;
  const loadModel = () => (resolvedModel ??= loader());
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async (options) => (await loadModel()).doGenerate(options),
    doStream: async (options) => (await loadModel()).doStream(options),
  } satisfies GenerateTextModel;
}

function openAiCompatibleModel(
  provider: 'llama-cpp' | 'lmstudio' | 'ollama' | 'openai-compatible' | 'openai-compatible-2' | 'openai-compatible-3',
  modelId: string,
  baseUrlEnvironmentName: string,
  defaultBaseURL: string,
  apiKeyEnvironmentName: string,
  extraRequestParametersEnvironmentName: string,
) {
  return lazyLanguageModel(provider, modelId, async () => {
    const baseURL = optionalEnvironmentValue(baseUrlEnvironmentName) || defaultBaseURL;
    if (!baseURL) {
      throw new Error(`${provider} has no Base URL. Configure the complete OpenAI-compatible /v1 endpoint in model settings.`);
    }
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const extraRequestParameters = extraOpenAICompatibleRequestParameters(extraRequestParametersEnvironmentName);
    return createOpenAICompatible({
      name: provider,
      baseURL,
      apiKey: optionalEnvironmentValue(apiKeyEnvironmentName),
      transformRequestBody: (body) => mergeExtraOpenAICompatibleRequestParameters(body, extraRequestParameters),
    })(modelId) as unknown as LoadedLanguageModel;
  });
}

export function withModelSettings<T>(settings: ModelSettingsOverride, callback: () => T): T {
  return modelSettingsStorage.run(settings, callback);
}

export function getModel(): GenerateTextModel {
  const { provider, model } = getModelSettings();
  if (provider === 'ai-gateway') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('AI_GATEWAY_BASE_URL');
    const { createGateway } = await import('@ai-sdk/gateway');
    return createGateway({
      apiKey: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY || '',
      baseURL,
    })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'alibaba') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('ALIBABA_BASE_URL');
    const { createAlibaba } = await import('@ai-sdk/alibaba');
    return createAlibaba({ apiKey: process.env.ALIBABA_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'anthropic') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('ANTHROPIC_BASE_URL');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'bedrock') return lazyLanguageModel(provider, model, async () => {
    const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
    return createAmazonBedrock({
      apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK || undefined,
      region: process.env.AWS_REGION || 'us-east-1',
    })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'cerebras') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('CEREBRAS_BASE_URL');
    const { createCerebras } = await import('@ai-sdk/cerebras');
    return createCerebras({ apiKey: process.env.CEREBRAS_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'cohere') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('COHERE_BASE_URL');
    const { createCohere } = await import('@ai-sdk/cohere');
    return createCohere({ apiKey: process.env.COHERE_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'codex') return getCodexModel(model);
  if (provider === 'deepseek') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('DEEPSEEK_BASE_URL');
    const { createDeepSeek } = await import('@ai-sdk/deepseek');
    return createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'deepinfra') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('DEEPINFRA_BASE_URL');
    const { createDeepInfra } = await import('@ai-sdk/deepinfra');
    return createDeepInfra({ apiKey: process.env.DEEPINFRA_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'fireworks') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('FIREWORKS_BASE_URL');
    const { createFireworks } = await import('@ai-sdk/fireworks');
    return createFireworks({ apiKey: process.env.FIREWORKS_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'google') return lazyLanguageModel(provider, model, async () => {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    return createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || '',
    })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'groq') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('GROQ_BASE_URL');
    const { createGroq } = await import('@ai-sdk/groq');
    return createGroq({ apiKey: process.env.GROQ_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'huggingface') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('HUGGINGFACE_BASE_URL');
    const { createHuggingFace } = await import('@ai-sdk/huggingface');
    return createHuggingFace({ apiKey: process.env.HUGGINGFACE_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'lmstudio') return openAiCompatibleModel(provider, model, 'LMSTUDIO_BASE_URL', 'http://localhost:1234/v1', 'LMSTUDIO_API_KEY', 'LMSTUDIO_EXTRA_REQUEST_PARAMETERS');
  if (provider === 'llama-cpp') return openAiCompatibleModel(provider, model, 'LLAMA_CPP_BASE_URL', 'http://localhost:8080/v1', 'LLAMA_CPP_API_KEY', 'LLAMA_CPP_EXTRA_REQUEST_PARAMETERS');
  if (provider === 'ollama') return openAiCompatibleModel(provider, model, 'OLLAMA_BASE_URL', 'http://localhost:11434/v1', 'OLLAMA_API_KEY', 'OLLAMA_EXTRA_REQUEST_PARAMETERS');
  if (provider === 'openai-compatible') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('OPENAI_COMPATIBLE_BASE_URL');
    if (!baseURL) {
      throw new Error('OpenAI 兼容接口尚未配置 Base URL。请在“模型配置”中填写完整的 /v1 地址。');
    }
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const extraRequestParameters = extraOpenAICompatibleRequestParameters('OPENAI_COMPATIBLE_EXTRA_REQUEST_PARAMETERS');
    return createOpenAICompatible({
      name: provider,
      baseURL,
      apiKey: optionalEnvironmentValue('OPENAI_COMPATIBLE_API_KEY'),
      transformRequestBody: (body) => mergeExtraOpenAICompatibleRequestParameters(body, extraRequestParameters),
    })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'openai-compatible-2') return openAiCompatibleModel(provider, model, 'OPENAI_COMPATIBLE_2_BASE_URL', '', 'OPENAI_COMPATIBLE_2_API_KEY', 'OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS');
  if (provider === 'openai-compatible-3') return openAiCompatibleModel(provider, model, 'OPENAI_COMPATIBLE_3_BASE_URL', '', 'OPENAI_COMPATIBLE_3_API_KEY', 'OPENAI_COMPATIBLE_3_EXTRA_REQUEST_PARAMETERS');
  if (provider === 'minimax') return lazyLanguageModel(provider, model, async () => {
    const baseURL = miniMaxOpenAIBaseURL();
    const { createMiniMaxOpenAIV4 } = await import('@/server/ai/providers/minimax-openai-v4-provider');
    return createMiniMaxOpenAIV4({
      apiKey: process.env.MINIMAX_API_KEY || '',
      baseURL: baseURL || 'https://api.minimax.io/v1',
      extraRequestParameters: extraOpenAICompatibleRequestParameters('MINIMAX_EXTRA_REQUEST_PARAMETERS'),
    })(model);
  });
  if (provider === 'openai') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('OPENAI_BASE_URL');
    const { createOpenAI } = await import('@ai-sdk/openai');
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'azure-openai') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('AZURE_OPENAI_BASE_URL') || 'http://mirrors.shterm.com:4000';
    const { createAzure } = await import('@ai-sdk/azure');
    return createAzure({ baseURL, apiKey: process.env.AZURE_OPENAI_API_KEY || '-' }).chat(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'mistral') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('MISTRAL_BASE_URL');
    const { createMistral } = await import('@ai-sdk/mistral');
    return createMistral({ apiKey: process.env.MISTRAL_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'perplexity') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('PERPLEXITY_BASE_URL');
    const { createPerplexity } = await import('@ai-sdk/perplexity');
    return createPerplexity({ apiKey: process.env.PERPLEXITY_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'togetherai') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('TOGETHERAI_BASE_URL');
    const { createTogetherAI } = await import('@ai-sdk/togetherai');
    return createTogetherAI({ apiKey: process.env.TOGETHERAI_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'vercel') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('VERCEL_BASE_URL');
    const { createVercel } = await import('@ai-sdk/vercel');
    return createVercel({ apiKey: process.env.VERCEL_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  if (provider === 'xai') return lazyLanguageModel(provider, model, async () => {
    const baseURL = optionalEnvironmentValue('XAI_BASE_URL');
    const { createXai } = await import('@ai-sdk/xai');
    return createXai({ apiKey: process.env.XAI_API_KEY || '', baseURL })(model) as unknown as LoadedLanguageModel;
  });
  return lazyLanguageModel('openrouter', model, async () => {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
    return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY || '' }).chat(model) as unknown as LoadedLanguageModel;
  });
}

export function getModelSettings() {
  const override = modelSettingsStorage.getStore();
  const provider = normalizeProvider(override?.provider || process.env.AI_PROVIDER);
  const defaults: Record<AiProvider, string> = {
    'ai-gateway': 'openai/gpt-5.5',
    alibaba: 'qwen-plus',
    anthropic: 'claude-sonnet-4-5',
    'azure-openai': 'deepseek-v4-pro',
    bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    cerebras: 'llama3.1-8b',
    codex: 'gpt-5.5',
    cohere: 'command-a-03-2025',
    deepinfra: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    deepseek: 'deepseek-v4-flash',
    fireworks: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    google: 'gemini-3-flash-preview',
    groq: 'llama-3.3-70b-versatile',
    huggingface: 'meta-llama/Llama-3.1-8B-Instruct',
    'llama-cpp': 'local-model',
    lmstudio: 'qwen3-vl-2b-instruct',
    minimax: 'minimax-m3',
    mistral: 'mistral-large-latest',
    ollama: 'llama3.1',
    openai: 'gpt-5.5',
    'openai-compatible': 'custom-model',
    'openai-compatible-2': 'custom-model',
    'openai-compatible-3': 'custom-model',
    openrouter: 'qwen/qwen3.6-27b',
    perplexity: 'sonar',
    togetherai: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    vercel: 'v0-1.5-md',
    xai: 'grok-4',
  };
  return {
    provider,
    model: override?.model || process.env.AI_MODEL || defaults[provider],
    supportsImageInput: override?.supportsImageInput === true,
  };
}

function getCodexModel(model: string): GenerateTextModel {
  const projectRoot = process.cwd();
  const codexPath = resolveCodexCliPath(process.env.CODEX_PATH, projectRoot);
  const cwd = process.env.CODEX_CWD || projectRoot;
  const approvalMode = parseApprovalMode(process.env.CODEX_APPROVAL_MODE) || 'on-request';
  const sandboxMode = parseSandboxMode(process.env.CODEX_SANDBOX_MODE) || 'workspace-write';
  const effort = parseReasoningEffort(process.env.AI_REASONING_EFFORT) || 'medium';
  const verbose = process.env.CODEX_VERBOSE === 'true';

  return lazyLanguageModel('codex', model, () => import('ai-sdk-provider-codex-cli').then((provider) => (
    process.env.CODEX_TRANSPORT === 'exec' || process.env.CODEX_PROVIDER_MODE === 'exec'
      ? provider.createCodexCli({
          defaultSettings: {
            codexPath,
            cwd,
            approvalMode,
            sandboxMode,
            reasoningEffort: effort,
            verbose,
            skipGitRepoCheck: process.env.CODEX_SKIP_GIT_REPO_CHECK !== 'false',
            allowNpx: process.env.CODEX_ALLOW_NPX === 'true',
          },
        })(model) as unknown as LoadedLanguageModel
      : provider.createCodexAppServer({
          defaultSettings: {
            codexPath,
            cwd,
            approvalPolicy: approvalMode,
            sandboxPolicy: sandboxMode,
            effort,
            verbose,
            minCodexVersion: '0.144.0',
            threadMode: 'stateless',
          },
        })(model) as unknown as LoadedLanguageModel
  )));
}

function normalizeProvider(value: string | undefined): AiProvider {
  const provider = String(value || 'openrouter').trim().toLowerCase();
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
  if (provider === 'groq') return 'groq';
  if (provider === 'huggingface' || provider === 'hugging-face') return 'huggingface';
  if (provider === 'llama-cpp' || provider === 'llamacpp' || provider === 'llama.cpp') return 'llama-cpp';
  if (provider === 'lmstudio' || provider === 'lm-studio' || provider === 'local') return 'lmstudio';
  if (provider === 'minimax') return 'minimax';
  if (provider === 'mistral' || provider === 'mistral-ai') return 'mistral';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'openai-compatible' || provider === 'openai-compatible-1' || provider === 'openai-compatible-api' || provider === 'custom-openai' || provider === 'custom-openai-1') return 'openai-compatible';
  if (provider === 'openai-compatible-2' || provider === 'custom-openai-2') return 'openai-compatible-2';
  if (provider === 'openai-compatible-3' || provider === 'custom-openai-3') return 'openai-compatible-3';
  if (provider === 'perplexity') return 'perplexity';
  if (provider === 'together' || provider === 'togetherai' || provider === 'together-ai') return 'togetherai';
  if (provider === 'vercel' || provider === 'v0') return 'vercel';
  if (provider === 'xai' || provider === 'x-ai') return 'xai';
  return 'openrouter';
}

function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  if (value === 'never' || value === 'on-request' || value === 'untrusted') return value;
  return undefined;
}

function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  return undefined;
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  return undefined;
}
