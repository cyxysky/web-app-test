import { generateObject } from 'ai';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getModel } from '@/server/ai/model';
import type { InteractiveBrowserTurnResult } from '@/server/ai/agents/browser-chat-executor.agent';
import type { TargetLeafNode, TargetResult } from '@/server/ai/schemas/target-workflow.schema';

const verificationSchema = z.object({
  status: z.enum(['passed', 'failed', 'inconclusive', 'blocked']),
  summary: z.string().min(1).max(4_000),
  failureReason: z.string().max(4_000).optional(),
  criteria: z.array(z.object({
    criterionId: z.string().min(1).max(120),
    status: z.enum(['passed', 'failed', 'inconclusive']),
    observation: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(4_000)).max(20),
  })).max(30),
  outputs: z.record(z.string(), z.unknown()),
});

function toolEvidence(result: InteractiveBrowserTurnResult) {
  return result.newSteps.map((step) => ({
    index: step.index,
    action: step.action,
    expected: step.expected,
    actual: step.actual,
    status: step.status,
    observation: step.observation,
    findings: step.findings,
    screenshots: [step.beforeScreenshotPath, step.afterScreenshotPath, step.screenshotPath].filter(Boolean),
    tools: (step.tools || []).map((tool) => ({
      name: tool.name,
      ok: tool.ok,
      reason: tool.reason,
      result: tool.result,
      screenshots: tool.screenshots,
    })),
  }));
}

function executionScreenshotPaths(result: InteractiveBrowserTurnResult) {
  return Array.from(new Set(result.newSteps.flatMap((step) => (
    [step.beforeScreenshotPath, step.afterScreenshotPath, step.screenshotPath, ...(step.tools || []).flatMap((tool) => tool.screenshots || [])]
      .filter((value): value is string => Boolean(value))
  ))));
}

function groundedCriterionEvidence(
  evidence: string[],
  validStepIndexes: Set<number>,
  validScreenshotPaths: Set<string>,
) {
  return evidence.filter((item) => {
    const stepMatch = item.match(/^\[step:(\d+)\]/i);
    if (stepMatch) return validStepIndexes.has(Number(stepMatch[1]));
    const screenshotMatch = item.match(/^\[screenshot:(.+?)\]/i);
    return Boolean(screenshotMatch && validScreenshotPaths.has(screenshotMatch[1]));
  });
}

export async function verifyTargetExecution(input: {
  target: TargetLeafNode;
  actorName?: string;
  execution: InteractiveBrowserTurnResult;
  startedAt: string;
  endedAt: string;
  abortSignal?: AbortSignal;
}): Promise<TargetResult> {
  const { target, execution } = input;
  if (execution.status === 'blocked') {
    const screenshotEvidence = executionScreenshotPaths(execution);
    const stepEvidence = execution.newSteps.slice(-8).map((step) => `[step:${step.index}] ${step.actual}`);
    return {
      targetId: target.id,
      actorId: target.actorId,
      status: 'blocked',
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      summary: execution.reply || '目标执行被前置条件或人工操作阻断。',
      failureReason: execution.reply || '需要人工处理后才能继续。',
      criteria: target.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        status: 'inconclusive',
        observation: '执行被阻断，尚未获得足够证据。',
        evidence: [],
      })),
      evidence: [...stepEvidence, ...screenshotEvidence],
      outputs: {},
      stepIndexes: execution.newSteps.map((step) => step.index),
    };
  }

  const screenshotPaths = executionScreenshotPaths(execution);
  const evidencePayload = toolEvidence(execution);
  const prompt = [
    '你是目标测试的只读验证 Agent。请只根据本次执行证据逐条判断成功标准。',
    '工具调用成功不等于目标通过；没有可观察证据时必须给 inconclusive。',
    '不得补充执行记录中不存在的事实。blocked 只用于确实需要外部前置条件的情况。',
    '每一条 evidence 都必须以 [step:<真实步骤编号>] 或 [screenshot:<下方给出的完整路径>] 开头；无法引用真实证据时不要输出该 evidence。',
    '逐条标准是最终结果的依据：存在 failed 标准时总体 failed；全部 passed 才能总体 passed；其余应为 inconclusive 或 blocked。',
    '',
    `执行者：${input.actorName || target.actorId || '匿名会话'}`,
    `目标：${target.title}`,
    `目标说明：${target.objective}`,
    `成功标准：\n${JSON.stringify(target.successCriteria, null, 2)}`,
    `运行时最终回答：${execution.reply || '[无]'}`,
    `运行时状态：${execution.status}`,
    `可引用的截图路径：\n${screenshotPaths.length ? screenshotPaths.join('\n') : '[无]'}`,
    `执行证据：\n${JSON.stringify(evidencePayload, null, 2)}`,
  ].join('\n');
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: prompt }];
  const selectedScreenshotPaths = screenshotPaths.slice(-6);
  for (const screenshotPath of selectedScreenshotPaths) {
    const image = await readFile(screenshotPath).catch(() => undefined);
    if (!image) continue;
    content.push({ type: 'text', text: `下面图片对应证据路径：${screenshotPath}` });
    content.push({ type: 'image', image });
  }
  const result = await generateObject({
    model: getModel(),
    schema: verificationSchema,
    temperature: 0,
    abortSignal: input.abortSignal,
    messages: [{ role: 'user', content }],
  });
  const verdict = result.object;
  const byCriterion = new Map(verdict.criteria.map((item) => [item.criterionId, item]));
  const validStepIndexes = new Set(execution.newSteps.map((step) => step.index));
  const validScreenshotPaths = new Set(screenshotPaths);
  const criteria = target.successCriteria.map((criterion) => {
    const returned = byCriterion.get(criterion.id);
    if (!returned) return {
      criterionId: criterion.id,
      status: 'inconclusive' as const,
      observation: '验证 Agent 未返回该标准的判断。',
      evidence: [],
    };
    const evidence = groundedCriterionEvidence(returned.evidence, validStepIndexes, validScreenshotPaths);
    if (returned.status !== 'inconclusive' && !evidence.length) {
      return {
        ...returned,
        status: 'inconclusive' as const,
        observation: `${returned.observation}（未引用有效的执行步骤或截图证据，因此降级为无法判断。）`,
        evidence: [],
      };
    }
    return { ...returned, evidence };
  });
  const hasFailedCriterion = criteria.some((criterion) => criterion.status === 'failed');
  const allCriteriaPassed = criteria.length > 0 && criteria.every((criterion) => criterion.status === 'passed');
  const status: TargetResult['status'] = hasFailedCriterion
    ? 'failed'
    : allCriteriaPassed
      ? 'passed'
      : verdict.status === 'blocked'
        ? 'blocked'
        : 'inconclusive';
  const failureReason = status === 'passed'
    ? undefined
    : verdict.failureReason
      || criteria.find((criterion) => criterion.status !== 'passed')?.observation
      || '没有足够证据证明全部成功标准均已满足。';
  return {
    targetId: target.id,
    actorId: target.actorId,
    status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    summary: verdict.summary,
    failureReason,
    criteria,
    evidence: Array.from(new Set([
      ...screenshotPaths,
      ...criteria.flatMap((criterion) => criterion.evidence),
    ])),
    outputs: verdict.outputs,
    stepIndexes: execution.newSteps.map((step) => step.index),
  };
}
