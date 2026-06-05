import { createAzure } from '@ai-sdk/azure';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { generateText } from 'ai';
import { createCodexCli, type ReasoningEffort } from 'ai-sdk-provider-codex-cli';
import { createGeminiProvider } from 'ai-sdk-provider-gemini-cli';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';


type GenerateTextModel = Parameters<typeof generateText>[0]['model'];
type AiProvider = 'azure-openai' | 'codex' | 'deepseek' | 'gemini' | 'google' | 'openai' | 'openrouter';
type ApprovalMode = 'never' | 'on-failure' | 'on-request' | 'untrusted';
type SandboxMode = 'danger-full-access' | 'read-only' | 'workspace-write';

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: 'http://localhost:1234/v1',
})('qwen3-vl-2b-instruct');

const gemini = createGeminiProvider({ authType: 'oauth-personal' });

const azureOpenAI = createAzure({
  baseURL: 'http://mirrors.shterm.com:8801/openai',
  apiKey: '-',
});

const openAI = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY || '',
});

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || '',
});

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || '',
});

const codexCli = createCodexCli({
  defaultSettings: {
    codexPath: process.env.CODEX_PATH || undefined,
    cwd: process.env.CODEX_CWD || process.cwd(),
    approvalMode: parseApprovalMode(process.env.CODEX_APPROVAL_MODE) || 'on-failure',
    sandboxMode: parseSandboxMode(process.env.CODEX_SANDBOX_MODE) || 'workspace-write',
    reasoningEffort: parseReasoningEffort(process.env.CODEX_REASONING_EFFORT) || 'medium',
    verbose: process.env.CODEX_VERBOSE === 'true',
    skipGitRepoCheck: process.env.CODEX_SKIP_GIT_REPO_CHECK !== 'false',
    allowNpx: process.env.CODEX_ALLOW_NPX === 'true',
  },
});

export function getModel(): GenerateTextModel {
  return lmstudio;
  const { provider, model } = getModelSettings();
  if (provider === 'gemini') return gemini(model) as unknown as GenerateTextModel;
  if (provider === 'codex') return codexCli(model) as unknown as GenerateTextModel;
  if (provider === 'deepseek') return deepseek(model) as unknown as GenerateTextModel;
  if (provider === 'google') return google(model) as unknown as GenerateTextModel;
  if (provider === 'openai') return openAI(model) as unknown as GenerateTextModel;
  if (provider === 'azure-openai') return azureOpenAI(model) as unknown as GenerateTextModel;
  return openrouter.chat(model) as unknown as GenerateTextModel;
}

export function getModelSettings() {
  const provider = normalizeProvider(process.env.AI_PROVIDER);
  const defaults: Record<AiProvider, string> = {
    'azure-openai': 'gpt-5.5',
    codex: 'gpt-5.5',
    deepseek: 'deepseek-v4-flash',
    google: 'gemini-3-flash-preview',
    openai: 'gpt-5.5',
    openrouter: 'qwen/qwen3.6-27b',
    gemini: 'gemini-3.1-pro-preview',
  };
  // gemini-3.1-pro-preview
  return {
    provider,
    model: process.env.AI_MODEL || defaults[provider],
  };
}

function normalizeProvider(value: string | undefined): AiProvider {
  const provider = String(value || 'openrouter').trim().toLowerCase();
  if (provider === 'azure' || provider === 'azure-openai') return 'azure-openai';
  if (provider === 'codex' || provider === 'codex-cli') return 'codex';
  if (provider === 'deepseek') return 'deepseek';
  if (provider === 'gemini' || provider === 'gemini-cli') return 'gemini';
  if (provider === 'google') return 'google';
  if (provider === 'openai') return 'openai';
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
