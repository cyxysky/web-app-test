import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/server/ai/model';
import { skillContentSchema, type SkillRecord, type StepExecutionResult, type TestCaseRecord, type TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

const generatedSkillSchema = z.object({
  title: z.string().min(2).max(80),
  description: z.string().min(8).max(240),
  tags: z.array(z.string().min(1).max(32)).min(1).max(6),
  triggerPhrases: z.array(z.string().min(2).max(80)).min(2).max(8),
  content: skillContentSchema.extend({
    workflow: z.array(z.string().min(4).max(260)).min(2).max(8),
    recovery: z.array(z.string().min(4).max(220)).max(3),
    verification: z.array(z.string().min(4).max(220)).min(1).max(4),
  }),
});

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
  return {
    name: tool.name,
    intent: reason && !normalizedText(stepAction).includes(normalizedText(reason)) ? reason : undefined,
    input: semanticInput && Object.keys(semanticInput as Record<string, unknown>).length
      ? safeJson(semanticInput, 420)
      : undefined,
    failed: tool.ok === false || undefined,
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

export async function generateSkillFromRun(input: {
  run: TestRunRecord;
  testCase: TestCaseRecord;
}): Promise<Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'status'>> {
  const { run, testCase } = input;
  const steps = run.result?.steps || [];
  if (!steps.length) throw new Error('Run has no executable steps to convert into a skill.');
  const sourceGoal = richTextToPlainText(
    testCase.content.userRequirement
    || testCase.description
    || testCase.title,
  );
  const rawConstraints = richTextToPlainText(testCase.content.systemPrompt || '');
  const stableConstraints = rawConstraints.includes('该上下文由浏览器对话生成') ? '' : rawConstraints;
  const diagnostics = run.status === 'passed'
    ? []
    : distinctText([
      ...(run.result?.consoleErrors || []).slice(-6),
      ...(run.result?.networkErrors || []).slice(-6),
    ], 6);

  const result = await generateObject({
    model: getModel(),
    schema: generatedSkillSchema,
    temperature: 0.2,
    prompt: [
      'You are converting a completed browser test execution record into a reusable application Skill.',
      'The Skill will be injected into future browser prompts. Minimize tokens and preserve only durable operating knowledge.',
      '',
      'Rules:',
      '- Write the skill in Chinese if the source requirement is Chinese; otherwise use the source language.',
      '- Description: one sentence that combines capability and precise usage scope. Do not repeat it elsewhere.',
      '- Trigger phrases: specific user intents that should activate this Skill. Avoid broad phrases such as "open website" or "search".',
      '- Workflow: 2-8 semantic action steps. Put a page-recognition or locator hint directly in its relevant step instead of creating a separate pattern section.',
      '- Recovery: only alternative actions for likely failures. Do not restate normal workflow steps or generic warnings.',
      '- Verification: only final observable success signals. Do not duplicate them as workflow steps.',
      '- Keep every fact in exactly one output field. Remove paraphrases and near-duplicates across fields.',
      '- Do NOT preserve volatile details: candidate ids, DOM node ids, coordinates, screenshot paths, run ids, temporary file names, timestamps, or raw tool JSON.',
      '- Do NOT include passwords, cookies, tokens, one-time codes, personal accounts, or secrets. Replace them with generic placeholders.',
      '- Avoid describing this as a report. It is a reusable operating skill for later AI browser runs.',
      '- Keep workflow steps actionable but semantic: describe what to find/click/check, not old ids or exact pixels.',
      '',
      `Reusable source JSON:\n${safeJson({
        title: testCase.title,
        targetUrl: testCase.targetUrl,
        goal: sourceGoal,
        constraints: stableConstraints || undefined,
        browserMode: testCase.content.browserMode,
        status: run.status,
        diagnostics: diagnostics.length ? diagnostics : undefined,
        steps: steps.map(compactStep),
      }, 10000)}`,
    ].join('\n'),
  });
  const workflow = distinctText(result.object.content.workflow, 8);
  const workflowKeys = new Set(workflow.map(normalizedText));
  const recovery = distinctText(result.object.content.recovery, 3)
    .filter((item) => !workflowKeys.has(normalizedText(item)));

  return {
    title: result.object.title,
    description: result.object.description,
    tags: distinctText(result.object.tags, 6),
    triggerPhrases: distinctText(result.object.triggerPhrases, 8),
    content: {
      workflow,
      recovery,
      verification: distinctText(result.object.content.verification, 4),
    },
    sourceRunId: run.id,
    sourceTestCaseId: testCase.id,
  };
}
