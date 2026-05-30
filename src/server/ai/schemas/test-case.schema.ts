import { z } from 'zod';

export const testStepSchema = z.object({
  index: z.number(),
  operation: z.enum(['open', 'click', 'fill', 'select', 'press', 'assert', 'wait', 'screenshot']).optional(),
  action: z.string(),
  input: z.string().optional(),
  expected: z.string(),
  riskLevel: z.enum(['safe', 'warning', 'dangerous']),
});

export const testCaseContentSchema = z.object({
  title: z.string(),
  description: z.string(),
  targetUrl: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  userRequirement: z.string().optional(),
  preconditions: z.array(z.string()),
  testData: z.record(z.string()),
  steps: z.array(testStepSchema).default([]),
  expectedResults: z.array(z.string()),
  risks: z.array(z.string()),
});

export type TestStep = z.infer<typeof testStepSchema>;
export type TestCaseContent = z.infer<typeof testCaseContentSchema>;

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
  createdAt: string;
  updatedAt: string;
};

export type StepExecutionResult = {
  index: number;
  action: string;
  expected: string;
  operation?: TestStep['operation'];
  actual: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked';
  tools?: StepToolCall[];
  screenshotPath?: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
};

export type StepToolCall = {
  name: string;
  input?: unknown;
  ok?: boolean;
  result?: string;
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
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked';
  startedAt?: string;
  endedAt?: string;
  result?: {
    steps: StepExecutionResult[];
    consoleErrors: string[];
    networkErrors: string[];
  };
  report?: {
    title: string;
    summary: string;
    markdown: string;
    suggestions: string[];
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
