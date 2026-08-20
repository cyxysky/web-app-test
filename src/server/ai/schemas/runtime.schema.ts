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

export const taskFrameDimensionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  focus: z.array(z.string()).optional(),
  testIdeas: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
});

export const taskFrameSchema = z.object({
  goal: z.string(),
  successCriteria: z.array(z.string()),
  dimensions: z.array(taskFrameDimensionSchema),
  deliverables: z.array(z.string()).optional(),
  analysisGuidance: z.array(z.string()).optional(),
  finalOutputRequirements: z.array(z.string()).optional(),
  version: z.number().optional(),
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

export type TaskFrame = z.infer<typeof taskFrameSchema>;

export type TaskLedgerItem = {
  id?: string;
  dimensionId: string;
  title: string;
  summary?: string;
  status?: 'finding' | 'issue' | 'covered' | 'risk' | 'question' | 'evidence' | 'decision';
  severity?: 'info' | 'minor' | 'major' | 'critical';
  expected?: string;
  actual?: string;
  evidence?: string[];
  confidence?: number;
  sourceStep?: number;
  attributes?: Array<{ key: string; value: string }>;
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
  observation?: string;
  findings?: string[];
  memoryItems?: string[];
  taskFrame?: TaskFrame;
  ledgerItems?: TaskLedgerItem[];
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
  status: 'queued' | 'running' | 'passed' | 'blocked' | 'failed';
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
  | 'openrouter'
  | 'perplexity'
  | 'togetherai'
  | 'vercel'
  | 'xai';

export type ModelProviderSettings = {
  enabled?: boolean;
  defaultModel?: string;
  model: string;
  models?: string[];
  apiKey?: string;
  hasApiKey?: boolean;
  baseURL?: string;
  updatedAt?: string;
};

export type ModelConfigRecord = {
  provider: ModelProvider;
  providers: Partial<Record<ModelProvider, ModelProviderSettings>>;
  updatedAt: string;
};
