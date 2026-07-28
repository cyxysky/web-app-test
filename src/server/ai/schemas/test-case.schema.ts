import { z } from 'zod';

export const testStepSchema = z.object({
  index: z.number(),
  operation: z.enum(['open', 'click', 'fill', 'select', 'press', 'assert', 'wait', 'screenshot']).optional(),
  action: z.string(),
  input: z.string().optional(),
  expected: z.string(),
  riskLevel: z.enum(['safe', 'warning', 'dangerous']),
});

export const recordedFlowStepSchema = z.object({
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
  workflow: z.array(z.string()).default([]),
  recovery: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
});

export function parseSkillContent(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return skillContentSchema.parse({
    ...record,
    recovery: record.recovery ?? record.cautions ?? [],
  });
}

export const testCaseContentSchema = z.object({
  title: z.string(),
  description: z.string(),
  targetUrl: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  browserMode: z.literal('dom').default('dom'),
  isMarked: z.boolean().default(true),
  userRequirement: z.string().optional(),
  systemPrompt: z.string().optional(),
  preconditions: z.array(z.string()),
  testData: z.record(z.string(), z.string()),
  steps: z.array(testStepSchema).default([]),
  expectedResults: z.array(z.string()),
  risks: z.array(z.string()),
  recordedFlow: z.array(recordedFlowStepSchema).optional(),
  defaultRecordedRunId: z.string().optional(),
  taskFrame: taskFrameSchema.optional(),
  skillIds: z.array(z.string()).optional(),
});

export type TestStep = z.infer<typeof testStepSchema>;
export type RecordedFlowStep = z.infer<typeof recordedFlowStepSchema>;
export type TestCaseContent = z.infer<typeof testCaseContentSchema>;
export type SkillContent = z.infer<typeof skillContentSchema>;

export type TestCaseRecord = {
  id: string;
  groupId?: string;
  title: string;
  description: string;
  targetUrl: string;
  status: 'draft' | 'generated' | 'ready' | 'running' | 'passed' | 'failed' | 'blocked';
  priority: TestCaseContent['priority'];
  content: TestCaseContent;
  imageNames: string[];
  strategyMemory?: string[];
  createdAt: string;
  updatedAt: string;
};

export type SkillRecord = {
  id: string;
  title: string;
  description: string;
  /** Empty means global; otherwise the Skill is loaded only for matching hosts. */
  domains?: string[];
  tags: string[];
  triggerPhrases: string[];
  content: SkillContent;
  sourceRunId?: string;
  sourceTestCaseId?: string;
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
  /** Browser-chat assistant message that owns this top-level step. */
  messageId?: string;
  action: string;
  expected: string;
  operation?: TestStep['operation'];
  actual: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked';
  tools?: StepToolCall[];
  aiRequest?: AiRequestSnapshot;
  /** The model's own short "what I did / what's next" note for this step, carried into later context. */
  note?: string;
  /** Assistant-facing observation of the current page/task state, not limited to tool-call reason. */
  observation?: string;
  /** Important findings such as product errors, requirements discovered, risks, or content summaries. */
  findings?: string[];
  /** Durable memory items that should influence later steps in the same run. */
  memoryItems?: string[];
  /** Dynamic task frame created for this run. Code treats dimensions generically. */
  taskFrame?: TaskFrame;
  /** Structured durable items appended by the AI during this step. */
  ledgerItems?: TaskLedgerItem[];
  screenshotPath?: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
  visualContext?: {
    current?: VisualFrameRecord;
    history: VisualFrameRecord[];
  };
  workingMemory?: RuntimeWorkingMemory;
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

export type RuntimeWorkingMemory = {
  taskGoal: string;
  phase: string;
  completed: string[];
  findings: string[];
  blockers: string[];
  lastAction?: string;
  lastResult?: string;
  pageUnderstanding?: string;
  currentState?: string;
  scrollSummary?: string;
  userConstraints: string[];
  nextStep?: string;
  taskFrame?: TaskFrame;
  ledgerItems?: TaskLedgerItem[];
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
  ok?: boolean;
  recovered?: boolean;
  transient?: boolean;
  result?: string;
  /** Complete tool result retained for the browser-chat detail dialog. */
  rawResult?: unknown;
  contextBefore?: AiToolContextSnapshot;
  contextAfter?: AiToolContextSnapshot;
  visualAfter?: {
    capture?: 'auto' | 'viewport' | 'fullPage';
    retention?: 'auto' | 'replace' | 'append';
    reason?: string;
  };
  screenshots?: Array<{
    title: string;
    path: string;
    kind?: 'current' | 'history' | 'pinned' | 'after' | 'marker' | 'original' | 'other';
  }>;
};

export type TestGroupRecord = {
  id: string;
  parentId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type RunDebugEvent = {
  time: string;
  phase: string;
  message: string;
  stepIndex?: number;
  details?: unknown;
};

export type TestRunRecord = {
  id: string;
  testCaseId: string;
  status: 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'blocked';
  queue?: {
    position?: number;
    attempts: number;
    enqueuedAt: string;
    startedAt?: string;
    workerId?: string;
    source?: 'single' | 'batch' | 'schedule' | 'replay' | 'continue';
  };
  startedAt?: string;
  endedAt?: string;
  result?: {
    steps: StepExecutionResult[];
    consoleErrors: string[];
    networkErrors: string[];
    tracePath?: string;
    taskFrame?: TaskFrame;
    ledgerItems?: TaskLedgerItem[];
    memory?: {
      summary: string;
      timeline: string[];
      findings: string[];
      failedAttempts: string[];
      updatedAt: string;
    };
  };
  report?: {
    title: string;
    summary: string;
    markdown: string;
    suggestions: string[];
  };
  analysis?: {
    pageChanges: Array<{
      stepIndex: number;
      changed: boolean;
      changeScore: number;
      summary: string;
    }>;
    repairSuggestions: string[];
    promptHints: string[];
    selfHealing: {
      applied: string[];
      nextRunStrategy: string[];
    };
  };
  debug?: {
    enabled: boolean;
    phase: string;
    stepIndex?: number;
    events: RunDebugEvent[];
  };
  control?: {
    skipRequestedAt?: string;
    skipStepIndex?: number;
    pauseRequestedAt?: string;
    pauseStepIndex?: number;
    pausedAt?: string;
    resumeRequestedAt?: string;
    resumeStepIndex?: number;
    manualIntervention?: {
      stepIndex: number;
      reason: string;
      requestedAt: string;
      screenshotPath?: string;
    };
  };
  createdAt: string;
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
  | 'google-vertex'
  | 'groq'
  | 'huggingface'
  | 'lmstudio'
  | 'llama-cpp'
  | 'mistral'
  | 'ollama'
  | 'openai'
  | 'openrouter'
  | 'perplexity'
  | 'togetherai'
  | 'vercel'
  | 'xai';

export type ModelProviderSettings = {
  defaultModel?: string;
  model: string;
  models?: string[];
  apiKey?: string;
  baseURL?: string;
  updatedAt?: string;
};

export type ModelConfigRecord = {
  provider: ModelProvider;
  providers: Partial<Record<ModelProvider, ModelProviderSettings>>;
  updatedAt: string;
};

export type RunScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  testCaseIds: string[];
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};
