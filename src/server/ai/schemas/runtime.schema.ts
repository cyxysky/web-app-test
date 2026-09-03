import { z } from 'zod';

export const browserOperationRecordSchema = z.object({
  index: z.number(),
  name: z.string(),
  input: z.unknown().optional(),
  reason: z.string().optional(),
  delayBeforeMs: z.number().optional(),
  waitForManual: z.boolean().optional(),
  sourceStepIndex: z.number().optional(),
  sourceStepAction: z.string().optional(),
  sourceStepExpected: z.string().optional(),
  sourceToolIndex: z.number().optional(),
});

export const skillContentSchema = z.object({
  details: z.string().default(''),
});

export function parseSkillContent(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return skillContentSchema.parse(record);
}

export type BrowserOperationRecord = z.infer<typeof browserOperationRecordSchema>;
export type SkillContent = z.infer<typeof skillContentSchema>;

export type SkillRecord = {
  id: string;
  userId: string;
  shared: boolean;
  title: string;
  description: string;
  triggerPhrases: string[];
  content: SkillContent;
  sourceSessionId?: string;
  status: 'draft' | 'ready' | 'disabled';
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type StepExecutionResult = {
  index: number;
  messageId?: string;
  action: string;
  expected: string;
  operation?: 'open' | 'click' | 'fill' | 'select' | 'press' | 'assert' | 'wait' | 'screenshot';
  actual: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked';
  tools?: StepToolCall[];
  aiRequest?: AiRequestSnapshot;
  note?: string;
  screenshotPath?: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
  visualContext?: {
    current?: VisualFrameRecord;
    history: VisualFrameRecord[];
  };
};

export type VisualFrameRecord = {
  id: string;
  path: string;
  originalPath?: string;
  markerPath?: string;
  role: 'current' | 'history' | 'pinned';
  reason: string;
  group?: string;
  stepIndex: number;
  toolName?: string;
  capture?: 'viewport' | 'fullPage';
  createdAt: string;
};

export type AiToolContextSnapshot = {
  requestId?: string;
  requestCreatedAt?: string;
  estimatedTotalTokens?: number;
  estimatedTextTokens?: number;
  estimatedImageTokens?: number;
  estimatedToolSchemaTokens?: number;
  imageCount?: number;
  method?: string;
};

export type AiRequestSnapshot = {
  id?: string;
  kind: 'runtime' | 'completion-verification';
  stepIndex: number;
  createdAt: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  screenshotPath?: string;
  imageAttached: boolean;
  tools?: string[];
  options?: Record<string, unknown>;
  messages: Array<{
    role: 'user' | 'system' | 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; imagePath?: string; attached: boolean }
    >;
  }>;
};

export type StepToolCall = {
  id?: string;
  name: string;
  input?: unknown;
  reason?: string;
  invalid?: boolean;
  error?: string;
  ok?: boolean;
  recovered?: boolean;
  transient?: boolean;
  result?: string;
  rawResult?: unknown;
  /** Complete elapsed time from tool dispatch through result post-processing. */
  elapsedMs?: number;
  /** Provider API response time for the model request that emitted this tool call. */
  aiRequestElapsedMs?: number;
  progress?: {
    phase: string;
    message: string;
    current?: number;
    total?: number;
    elapsedMs?: number;
  };
  contextBefore?: AiToolContextSnapshot;
  contextAfter?: AiToolContextSnapshot;
  screenshots?: Array<{
    title: string;
    path: string;
    kind?: 'current' | 'history' | 'pinned' | 'after' | 'marker' | 'original' | 'other';
  }>;
};

export type BrowserChatAiOutputTool = {
  id: string;
  input?: unknown;
  name: string;
  reason?: string;
  invalid?: boolean;
  error?: string;
  /** The provider's own tool-result, paired to this call by toolCallId. */
  ok?: boolean;
  result?: string;
  rawResult?: unknown;
  progress?: {
    phase: string;
    message: string;
    current?: number;
    total?: number;
    elapsedMs?: number;
  };
};

export type BrowserChatAiOutputPart =
  | { index: number; kind: 'reasoning' }
  | { index: number; kind: 'text' }
  | { index: number; kind: 'tool' };

export type BrowserChatAiOutputView = {
  parts: BrowserChatAiOutputPart[];
  reasoning: string[];
  texts: string[];
  tools: BrowserChatAiOutputTool[];
};

export type BrowserChatAiOutputCycle = {
  id: string;
  messageId?: string;
  output: BrowserChatAiOutputView;
  stepIndex?: number;
  agentStepIndex?: number;
  sequence?: number;
  createdAt?: string;
  sourceCycleId?: string;
  subagentId?: string;
  batchId?: string;
};

export type BrowserChatSubagentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
};

export type BrowserChatSubagentRecord = {
  id: string;
  messageId: string;
  batchId: string;
  index: number;
  title: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'passed' | 'blocked' | 'failed' | 'stopped';
  content: string;
  summary?: string;
  resumable: boolean;
  toolCount: number;
  currentAction?: string;
  steps: StepExecutionResult[];
  outputCycles: BrowserChatAiOutputCycle[];
  messages: BrowserChatSubagentMessage[];
  error?: string;
};

export type RuntimeEnvRecord = {
  key: string;
  value: string;
  enabled: boolean;
  secret?: boolean;
  updatedAt: string;
};

export type ModelProvider =
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
  | 'lmstudio'
  | 'llama-cpp'
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

export type ModelProviderSettings = {
  displayName?: string;
  enabled?: boolean;
  defaultModel?: string;
  model: string;
  models?: string[];
  modelCapabilities?: Record<string, {
    imageInput: boolean;
  }>;
  apiKey?: string;
  hasApiKey?: boolean;
  baseURL?: string;
  /** JSON object merged into OpenAI-compatible chat-completion request bodies. */
  extraRequestParameters?: string;
  updatedAt?: string;
};

export type ModelConfigRecord = {
  provider: ModelProvider;
  providers: Partial<Record<ModelProvider, ModelProviderSettings>>;
  updatedAt: string;
};
