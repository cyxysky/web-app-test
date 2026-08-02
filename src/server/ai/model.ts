import { AsyncLocalStorage } from 'node:async_hooks';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCerebras } from '@ai-sdk/cerebras';
import { createCohere } from '@ai-sdk/cohere';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createFireworks } from '@ai-sdk/fireworks';
import { createGateway } from '@ai-sdk/gateway';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createHuggingFace } from '@ai-sdk/huggingface';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createVercel } from '@ai-sdk/vercel';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { generateText } from 'ai';
import { createCodexAppServer, createCodexCli, type ReasoningEffort } from 'ai-sdk-provider-codex-cli';

type GenerateTextModel = Parameters<typeof generateText>[0]['model'];
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
  | 'mistral'
  | 'ollama'
  | 'openai'
  | 'openrouter'
  | 'perplexity'
  | 'togetherai'
  | 'vercel'
  | 'xai';
type ApprovalMode = 'never' | 'on-failure' | 'on-request' | 'untrusted';
type SandboxMode = 'danger-full-access' | 'read-only' | 'workspace-write';
export type ModelSettingsOverride = {
  provider?: string;
  model?: string;
};

const modelSettingsStorage = new AsyncLocalStorage<ModelSettingsOverride>();

export function withModelSettings<T>(settings: ModelSettingsOverride, callback: () => T): T {
  return modelSettingsStorage.run(settings, callback);
}

export function getModel(): GenerateTextModel {
  const { provider, model } = getModelSettings();
  if (provider === 'ai-gateway') return createGateway({
    apiKey: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY || '',
    baseURL: process.env.AI_GATEWAY_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'alibaba') return createAlibaba({
    apiKey: process.env.ALIBABA_API_KEY || '',
    baseURL: process.env.ALIBABA_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'anthropic') return createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'bedrock') return createAmazonBedrock({
    apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK || undefined,
    region: process.env.AWS_REGION || 'us-east-1',
  })(model) as unknown as GenerateTextModel;
  if (provider === 'cerebras') return createCerebras({
    apiKey: process.env.CEREBRAS_API_KEY || '',
    baseURL: process.env.CEREBRAS_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'cohere') return createCohere({
    apiKey: process.env.COHERE_API_KEY || '',
    baseURL: process.env.COHERE_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'codex') return getCodexModel(model);
  if (provider === 'deepseek') return createDeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseURL: process.env.DEEPSEEK_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'deepinfra') return createDeepInfra({
    apiKey: process.env.DEEPINFRA_API_KEY || '',
    baseURL: process.env.DEEPINFRA_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'fireworks') return createFireworks({
    apiKey: process.env.FIREWORKS_API_KEY || '',
    baseURL: process.env.FIREWORKS_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'google') return createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || '',
  })(model) as unknown as GenerateTextModel;
  if (provider === 'groq') return createGroq({
    apiKey: process.env.GROQ_API_KEY || '',
    baseURL: process.env.GROQ_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'huggingface') return createHuggingFace({
    apiKey: process.env.HUGGINGFACE_API_KEY || '',
    baseURL: process.env.HUGGINGFACE_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'lmstudio') return createOpenAICompatible({
    name: 'lmstudio',
    baseURL: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1',
    apiKey: process.env.LMSTUDIO_API_KEY || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'llama-cpp') return createOpenAICompatible({
    name: 'llama-cpp',
    baseURL: process.env.LLAMA_CPP_BASE_URL || 'http://localhost:8080/v1',
    apiKey: process.env.LLAMA_CPP_API_KEY || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'ollama') return createOpenAICompatible({
    name: 'ollama',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    apiKey: process.env.OLLAMA_API_KEY || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'openai') return createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'azure-openai') return createAzure({
    baseURL: process.env.AZURE_OPENAI_BASE_URL || 'http://mirrors.shterm.com:4000',
    apiKey: process.env.AZURE_OPENAI_API_KEY || '-',
  }).chat(model) as unknown as GenerateTextModel;
  if (provider === 'mistral') return createMistral({
    apiKey: process.env.MISTRAL_API_KEY || '',
    baseURL: process.env.MISTRAL_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'perplexity') return createPerplexity({
    apiKey: process.env.PERPLEXITY_API_KEY || '',
    baseURL: process.env.PERPLEXITY_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'togetherai') return createTogetherAI({
    apiKey: process.env.TOGETHERAI_API_KEY || '',
    baseURL: process.env.TOGETHERAI_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'vercel') return createVercel({
    apiKey: process.env.VERCEL_API_KEY || '',
    baseURL: process.env.VERCEL_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  if (provider === 'xai') return createXai({
    apiKey: process.env.XAI_API_KEY || '',
    baseURL: process.env.XAI_BASE_URL || undefined,
  })(model) as unknown as GenerateTextModel;
  return createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY || '',
  }).chat(model) as unknown as GenerateTextModel;
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
    mistral: 'mistral-large-latest',
    ollama: 'llama3.1',
    openai: 'gpt-5.5',
    openrouter: 'qwen/qwen3.6-27b',
    perplexity: 'sonar',
    togetherai: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    vercel: 'v0-1.5-md',
    xai: 'grok-4',
  };
  return {
    provider,
    model: override?.model || process.env.AI_MODEL || defaults[provider],
  };
}

function getCodexModel(model: string): GenerateTextModel {
  const codexPath = process.env.CODEX_PATH || undefined;
  const cwd = process.env.CODEX_CWD || process.cwd();
  const approvalMode = parseApprovalMode(process.env.CODEX_APPROVAL_MODE) || 'on-failure';
  const sandboxMode = parseSandboxMode(process.env.CODEX_SANDBOX_MODE) || 'workspace-write';
  const effort = parseReasoningEffort(process.env.CODEX_REASONING_EFFORT) || 'medium';
  const verbose = process.env.CODEX_VERBOSE === 'true';

  if (process.env.CODEX_TRANSPORT === 'exec' || process.env.CODEX_PROVIDER_MODE === 'exec') {
    return createCodexCli({
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
    })(model) as unknown as GenerateTextModel;
  }

  return createCodexAppServer({
    defaultSettings: {
      codexPath,
      cwd,
      approvalPolicy: approvalMode,
      sandboxPolicy: sandboxMode,
      effort,
      verbose,
      minCodexVersion: '0.130.0',
      threadMode: 'stateless',
    },
  })(model) as unknown as GenerateTextModel;
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
  if (provider === 'mistral' || provider === 'mistral-ai') return 'mistral';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'perplexity') return 'perplexity';
  if (provider === 'together' || provider === 'togetherai' || provider === 'together-ai') return 'togetherai';
  if (provider === 'vercel' || provider === 'v0') return 'vercel';
  if (provider === 'xai' || provider === 'x-ai') return 'xai';
  return 'openrouter';
}

function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  if (value === 'never' || value === 'on-request' || value === 'on-failure' || value === 'untrusted') return value;
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
