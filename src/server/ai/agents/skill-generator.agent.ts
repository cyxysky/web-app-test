import { generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/server/ai/model';
import { skillContentSchema, type SkillRecord, type StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { normalizeSkillDomain } from './skill-context';

const generatedSkillSchema = z.object({
  title: z.string().min(2).max(80),
  description: z.string().min(8).max(240),
  triggerPhrases: z.array(z.string().min(2).max(80)).min(2).max(8),
  content: skillContentSchema.extend({
    details: z.string().min(20).max(8_000),
  }),
});

function extractGeneratedSkillJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    throw new Error('Skill model response did not contain a JSON object.');
  }
}

export function parseGeneratedSkillText(text: string) {
  const parsed = generatedSkillSchema.safeParse(extractGeneratedSkillJson(text));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Skill model response is invalid: ${detail}`);
  }
  return parsed.data;
}

function compactText(value: unknown, max = 800) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function safeJson(value: unknown, max = 1400) {
  try {
    return compactText(JSON.stringify(value), max);
  } catch {
    return compactText(String(value), max);
  }
}

const volatileToolInputKey = /^(?:uid|touid|x|y|tox|toy|xthousandth|ythousandth|toxthousandth|toythousandth|cursor|snapshotid|screenshotid|runid|stepindex|clientmessageid)$/i;

function semanticToolInput(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => semanticToolInput(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !volatileToolInputKey.test(key))
    .map(([key, item]) => [key, semanticToolInput(item, depth + 1)]));
}

function normalizedText(value: unknown) {
  return compactText(value, 1000).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function distinctText(items: unknown[], max: number) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const value = compactText(item, 260);
    const key = normalizedText(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= max) break;
  }
  return output;
}

function compactTool(tool: NonNullable<StepExecutionResult['tools']>[number], stepAction: string) {
  const reason = compactText(tool.reason, 180);
  const semanticInput = semanticToolInput(tool.input);
  const recoveredTransient = tool.recovered === true && tool.transient === true;
  return {
    name: tool.name,
    intent: reason && !normalizedText(stepAction).includes(normalizedText(reason)) ? reason : undefined,
    input: semanticInput && Object.keys(semanticInput as Record<string, unknown>).length
      ? safeJson(semanticInput, 420)
      : undefined,
    recovered: recoveredTransient || undefined,
    failed: (tool.ok === false && !recoveredTransient) || undefined,
  };
}

function compactStep(step: StepExecutionResult) {
  const action = compactText(step.action, 280);
  const expected = compactText(step.expected, 240);
  const actual = compactText(step.actual, 320);
  return {
    index: step.index,
    status: step.status,
    goal: action,
    expected: expected && normalizedText(expected) !== normalizedText(action) ? expected : undefined,
    outcome: actual && normalizedText(actual) !== normalizedText(expected) ? actual : undefined,
    findings: distinctText([step.note, ...(step.findings || [])], 4),
    tools: (step.tools || []).map((tool) => compactTool(tool, action)).slice(0, 6),
  };
}

export async function generateSkillFromBrowserHistory(input: {
  browserMode: 'code' | 'dom';
  consoleErrors?: string[];
  constraints?: string;
  goal: string;
  networkErrors?: string[];
  sourceId: string;
  status: 'passed' | 'failed' | 'blocked';
  steps: StepExecutionResult[];
  targetUrl: string;
  title: string;
}): Promise<Omit<SkillRecord, 'id' | 'userId' | 'shared' | 'createdAt' | 'updatedAt' | 'version' | 'status'>> {
  const { steps } = input;
  if (!steps.length) throw new Error('Run has no executable steps to convert into a skill.');
  const diagnostics = input.status === 'passed'
    ? []
    : distinctText([
      ...(input.consoleErrors || []).slice(-6),
      ...(input.networkErrors || []).slice(-6),
    ], 6);

  const result = await generateText({
    model: getModel(),
    temperature: 0.2,
    prompt: [
      'You are converting a completed browser test execution record into a reusable application Skill.',
      'The Skill will be injected into future browser prompts. Minimize tokens and preserve only durable operating knowledge.',
      '',
      'Rules:',
      '- Write the skill in Chinese if the source requirement is Chinese; otherwise use the source language.',
      '- Description: one sentence that combines capability and precise usage scope. Do not repeat it elsewhere.',
      '- Treat the supplied constraints as the user requested summarization direction. Use them to decide which workflow, decisions, and reusable details are central.',
      '- Trigger phrases: specific user intents that should activate this Skill. Avoid broad phrases such as "open website" or "search".',
      '- Details: write the complete reusable operating guidance as one structured Markdown block. Include page recognition, stable locator hints, ordered actions, useful branches, and observable success conditions where they matter.',
      '- Keep every fact in exactly one output field. Remove paraphrases and near-duplicates across fields.',
      '- Do NOT preserve volatile details: candidate ids, DOM node ids, coordinates, screenshot paths, run ids, temporary file names, timestamps, or raw tool JSON.',
      '- Do NOT include passwords, cookies, tokens, one-time codes, personal accounts, or secrets. Replace them with generic placeholders.',
      '- Avoid describing this as a report. It is a reusable operating skill for later AI browser runs.',
      '- Keep the details actionable but semantic: describe what to find/click/check, not old ids or exact pixels.',
      '- Return exactly one JSON object. Do not use Markdown fences or add explanatory text.',
      '- JSON shape: {"title":"...","description":"...","triggerPhrases":["..."],"content":{"details":"..."}}.',
      '',
      `Reusable source JSON:\n${safeJson({
        title: input.title,
        targetUrl: input.targetUrl,
        goal: input.goal,
        constraints: input.constraints || undefined,
        browserMode: input.browserMode,
        status: input.status,
        diagnostics: diagnostics.length ? diagnostics : undefined,
        steps: steps.map(compactStep),
      }, 10000)}`,
    ].join('\n'),
  });
  const generated = parseGeneratedSkillText(result.text);
  return {
    title: generated.title,
    description: generated.description,
    domains: [normalizeSkillDomain(input.targetUrl)].filter(Boolean),
    triggerPhrases: distinctText(generated.triggerPhrases, 8),
    content: {
      details: generated.content.details.trim(),
    },
    sourceSessionId: input.sourceId,
  };
}
