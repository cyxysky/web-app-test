import type { DynamicToolUIPart, UIMessage } from 'ai';
import { z } from 'zod';
import type {
  BrowserChatAiOutputCycle,
  BrowserChatSubagentRecord,
  StepExecutionResult,
} from '@/server/ai/schemas/runtime.schema';

const browserChatUIValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(browserChatUIValueSchema).max(100),
  z.record(z.string(), browserChatUIValueSchema),
]));

export const browserChatUINodeSchema: z.ZodType<BrowserChatUINode> = z.lazy(() => z.object({
  type: z.enum([
    'card',
    'stack',
    'row',
    'grid',
    'text',
    'markdown',
    'heading',
    'badge',
    'time',
    'stat',
    'progress',
    'divider',
    'keyValue',
    'timeline',
    'link',
  ]).describe('Declarative primitive. Compose time cards with card/stack/time; metrics with grid/stat/progress; details with keyValue/timeline.'),
  props: z.record(z.string(), browserChatUIValueSchema).optional().describe('Primitive props: title/description; text/tone; columns; label/value/detail; locale/timeZone/dateStyle/timeStyle; items[{label,value}]; href.'),
  children: z.array(z.union([z.string().max(10_000), browserChatUINodeSchema])).max(100).optional(),
}).strict());

export type BrowserChatUINode = {
  type: 'card' | 'stack' | 'row' | 'grid' | 'text' | 'markdown' | 'heading' | 'badge' | 'time' | 'stat' | 'progress' | 'divider' | 'keyValue' | 'timeline' | 'link';
  props?: Record<string, unknown>;
  children?: Array<string | BrowserChatUINode>;
};

export const browserChatFinalBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('markdown'),
    text: z.string().min(1).max(40_000),
  }).strict(),
  z.object({
    type: z.literal('chart'),
    chartId: z.string().regex(/^chart_\d{6}$/),
    title: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  z.object({
    type: z.literal('ui'),
    id: z.string().trim().min(1).max(120).optional(),
    tree: browserChatUINodeSchema,
  }).strict(),
]);

export const browserChatFinalResponseSchema = z.object({
  status: z.enum(['passed', 'failed', 'blocked']).default('passed'),
  blocks: z.array(browserChatFinalBlockSchema).min(1).max(64),
}).strict();

export type BrowserChatFinalBlock = z.infer<typeof browserChatFinalBlockSchema>;
export type BrowserChatFinalResponse = z.infer<typeof browserChatFinalResponseSchema>;

export type BrowserChatUIMessageMetadata = {
  sessionId: string;
  clientMessageId?: string;
  createdAt: string;
  updatedAt?: string;
  status?: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
  attachments?: unknown[];
  skillIds?: string[];
};

export type BrowserChatUIDataTypes = {
  chart: { chartId: string; title?: string };
  ui: { id?: string; tree: BrowserChatUINode };
  step: StepExecutionResult;
  outputCycle: BrowserChatAiOutputCycle;
  subagent: BrowserChatSubagentRecord;
  activity: { phase: string; label: string; updatedAt: string };
};

export type BrowserChatUIMessage = UIMessage<BrowserChatUIMessageMetadata, BrowserChatUIDataTypes>;
export type BrowserChatUIMessagePart = BrowserChatUIMessage['parts'][number];

export function browserChatFinalBlocksToParts(blocks: BrowserChatFinalBlock[]): BrowserChatUIMessagePart[] {
  return blocks.map((block): BrowserChatUIMessagePart => {
    if (block.type === 'markdown') return { type: 'text', text: block.text };
    if (block.type === 'chart') {
      return {
        type: 'data-chart',
        id: block.chartId,
        data: { chartId: block.chartId, ...(block.title ? { title: block.title } : {}) },
      };
    }
    return {
      type: 'data-ui',
      id: block.id,
      data: { id: block.id, tree: block.tree },
    };
  });
}

export function browserChatFinalBlocksToText(blocks: BrowserChatFinalBlock[]) {
  return blocks.map((block) => {
    if (block.type === 'markdown') return block.text;
    if (block.type === 'chart') return block.chartId;
    return '';
  }).filter(Boolean).join('\n\n');
}

export function browserChatToolPartFromStep(
  step: StepExecutionResult,
  toolIndex: number,
): DynamicToolUIPart | undefined {
  const tool = step.tools?.[toolIndex];
  if (!tool || tool.name === 'finalResponse') return undefined;
  const base = {
    type: 'dynamic-tool' as const,
    toolName: tool.name,
    toolCallId: tool.id || `step-${step.index}-tool-${toolIndex}`,
    input: tool.input,
  };
  if (tool.ok === true) return { ...base, state: 'output-available', output: tool.result ?? null };
  if (tool.ok === false || tool.error) {
    return { ...base, state: 'output-error', errorText: tool.error || tool.result || 'Tool execution failed.' };
  }
  return { ...base, state: 'input-available' };
}

export function browserChatExecutionParts(steps: StepExecutionResult[]): BrowserChatUIMessagePart[] {
  return [...steps]
    .sort((left, right) => left.index - right.index)
    .flatMap((step) => {
      if (step.tools?.length && step.tools.every((tool) => tool.name === 'finalResponse')) return [];
      return [
        ...((step.tools || []).flatMap((_tool, toolIndex) => {
        const part = browserChatToolPartFromStep(step, toolIndex);
        return part ? [part] : [];
        })),
        { type: 'data-step' as const, id: `step-${step.index}`, data: step },
      ];
    });
}
