import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/server/ai/model';
import { skillContentSchema, type SkillRecord, type StepExecutionResult, type TestCaseRecord, type TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

const generatedSkillSchema = z.object({
  title: z.string().min(2).max(80),
  description: z.string().min(8).max(360),
  tags: z.array(z.string().min(1).max(32)).min(1).max(8),
  triggerPhrases: z.array(z.string().min(1).max(80)).min(2).max(12),
  content: skillContentSchema.extend({
    whenToUse: z.array(z.string().min(4).max(220)).min(1).max(8),
    workflow: z.array(z.string().min(4).max(320)).min(2).max(12),
    reusablePatterns: z.array(z.string().min(4).max(260)).max(10),
    cautions: z.array(z.string().min(4).max(260)).max(8),
    verification: z.array(z.string().min(4).max(260)).min(1).max(8),
    sourceSummary: z.string().min(8).max(700),
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

function compactTool(tool: NonNullable<StepExecutionResult['tools']>[number]) {
  return {
    name: tool.name,
    reason: compactText(tool.reason, 220) || undefined,
    input: tool.input ? safeJson(tool.input, 500) : undefined,
    ok: tool.ok,
    result: compactText(tool.result, 420) || undefined,
    beforeUrl: tool.contextBefore?.domContext?.url,
    afterUrl: tool.contextAfter?.domContext?.url,
  };
}

function compactStep(step: StepExecutionResult) {
  return {
    index: step.index,
    status: step.status,
    action: compactText(step.action, 360),
    expected: compactText(step.expected, 360),
    actual: compactText(step.actual, 520),
    note: compactText(step.note, 260) || undefined,
    findings: (step.findings || []).map((item) => compactText(item, 260)).slice(0, 8),
    tools: (step.tools || []).map(compactTool).slice(0, 8),
  };
}

export async function generateSkillFromRun(input: {
  run: TestRunRecord;
  testCase: TestCaseRecord;
}): Promise<Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'status'>> {
  const { run, testCase } = input;
  const steps = run.result?.steps || [];
  if (!steps.length) throw new Error('Run has no executable steps to convert into a skill.');

  const result = await generateObject({
    model: getModel(),
    schema: generatedSkillSchema,
    temperature: 0.2,
    prompt: [
      'You are converting a completed browser test execution record into a reusable application Skill.',
      'The Skill will be injected into future browser-test prompts, so it must be concise, procedural, and reusable.',
      '',
      'Rules:',
      '- Write the skill in Chinese if the source requirement is Chinese; otherwise use the source language.',
      '- Preserve stable domain knowledge, workflows, page-recognition hints, recovery patterns, and verification criteria.',
      '- Do NOT preserve volatile details: candidate ids, DOM node ids, coordinates, screenshot paths, run ids, temporary file names, timestamps, or raw tool JSON.',
      '- Do NOT include passwords, cookies, tokens, one-time codes, personal accounts, or secrets. Replace them with generic placeholders.',
      '- Avoid describing this as a report. It is a reusable operating skill for later AI browser runs.',
      '- Keep workflow steps actionable but semantic: describe what to find/click/check, not old ids or exact pixels.',
      '',
      `Test case JSON:\n${safeJson({
        id: testCase.id,
        title: testCase.title,
        targetUrl: testCase.targetUrl,
        description: testCase.description,
        userRequirement: richTextToPlainText(testCase.content.userRequirement || testCase.description),
        systemPrompt: richTextToPlainText(testCase.content.systemPrompt || ''),
        browserMode: testCase.content.browserMode,
      }, 2400)}`,
      '',
      `Run JSON:\n${safeJson({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        consoleErrors: run.result?.consoleErrors?.slice(-10) || [],
        networkErrors: run.result?.networkErrors?.slice(-10) || [],
        reportSummary: run.report?.summary,
      }, 1600)}`,
      '',
      `Execution steps JSON:\n${safeJson(steps.map(compactStep), 12000)}`,
    ].join('\n'),
  });

  return {
    title: result.object.title,
    description: result.object.description,
    tags: result.object.tags,
    triggerPhrases: result.object.triggerPhrases,
    content: result.object.content,
    sourceRunId: run.id,
    sourceTestCaseId: testCase.id,
  };
}
