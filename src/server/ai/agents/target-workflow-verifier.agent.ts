import { generateObject, NoObjectGeneratedError } from 'ai';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getModel } from '@/server/ai/model';
import type { InteractiveBrowserTurnResult } from '@/server/ai/agents/browser-chat-executor.agent';
import type { TargetLeafNode, TargetResult } from '@/server/ai/schemas/target-workflow.schema';

export const targetVerificationSchema = z.object({
  status: z.enum(['passed', 'failed', 'inconclusive', 'blocked']),
  summary: z.string().min(1).max(4_000),
  failureReason: z.string().max(4_000).optional(),
  criteria: z.array(z.object({
    criterionId: z.string().min(1).max(120),
    status: z.enum(['passed', 'failed', 'inconclusive']),
    observation: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(4_000)).max(20).default([]),
  })).max(30).default([]),
  outputs: z.record(z.string(), z.unknown()).default({}),
});

type VerificationVerdict = z.infer<typeof targetVerificationSchema>;

function jsonObjectFromText(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const extracted = firstBrace >= 0 && lastBrace > firstBrace
    ? trimmed.slice(firstBrace, lastBrace + 1)
    : undefined;
  for (const candidate of [trimmed, fenced, extracted]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next representation. The original SDK error is retained if
      // none of the deterministic repairs can be parsed.
    }
  }
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
}

function normalizedStatus(value: unknown, fallback: VerificationVerdict['status'] = 'inconclusive') {
  if (typeof value !== 'string') return fallback;
  const status = value.trim().toLowerCase();
  if (['passed', 'pass', 'success', 'successful', 'ok', '通过', '成功'].includes(status)) return 'passed' as const;
  if (['failed', 'fail', 'failure', 'error', '失败', '不通过'].includes(status)) return 'failed' as const;
  if (['blocked', 'block', '阻塞', '被阻断'].includes(status)) return 'blocked' as const;
  if (['inconclusive', 'unknown', 'uncertain', '无法判断', '不确定'].includes(status)) return 'inconclusive' as const;
  return fallback;
}

function normalizedEvidence(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())
    .slice(0, 20);
}

function normalizedCriterionStatus(value: unknown) {
  const status = normalizedStatus(value, 'inconclusive');
  return status === 'blocked' ? 'inconclusive' as const : status;
}

/**
 * Repair common provider deviations without another model call. This covers
 * fenced JSON, nullable optional fields, omitted containers and the common
 * aliases emitted by models that do not follow the response schema exactly.
 */
export function repairTargetVerificationText(text: string) {
  const parsed = jsonObjectFromText(text);
  const parsedRecord = recordOf(parsed);
  const root = recordOf(parsedRecord?.result) || recordOf(parsedRecord?.verdict) || parsedRecord;
  if (!root) return null;
  const criteriaRecord = recordOf(root.criteria);
  const rawCriteria = Array.isArray(root.criteria)
    ? root.criteria
    : Array.isArray(root.successCriteria)
      ? root.successCriteria
      : criteriaRecord
        ? Object.entries(criteriaRecord).map(([criterionId, value]) => ({
            ...recordOf(value),
            criterionId: nonEmptyString(recordOf(value)?.criterionId, recordOf(value)?.id, criterionId),
          }))
        : [];
  const criteria = rawCriteria.flatMap((item) => {
    const criterion = recordOf(item);
    if (!criterion) return [];
    const criterionId = nonEmptyString(criterion.criterionId, criterion.criterion_id, criterion.id, criterion.key);
    const observation = nonEmptyString(
      criterion.observation,
      criterion.actual,
      criterion.summary,
      criterion.reason,
      criterion.message,
    );
    if (!criterionId || !observation) return [];
    return [{
      criterionId,
      status: normalizedCriterionStatus(criterion.status),
      observation,
      evidence: normalizedEvidence(criterion.evidence ?? criterion.evidences ?? criterion.references),
    }];
  });
  const status = normalizedStatus(root.status ?? root.result ?? root.verdict, 'inconclusive');
  const summary = nonEmptyString(root.summary, root.observation, root.message, root.reason)
    || `验证结果：${status}`;
  const failureReason = nonEmptyString(root.failureReason, root.failure_reason, root.error);
  const outputs = recordOf(root.outputs) || recordOf(root.output) || {};
  const normalized = {
    status,
    summary,
    ...(failureReason ? { failureReason } : {}),
    criteria,
    outputs,
  };
  return JSON.stringify(normalized);
}

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

export function groundedCriterionEvidence(
  evidence: string[],
  validStepIndexes: Set<number>,
  validScreenshotPaths: Set<string>,
) {
  return evidence.flatMap((item) => {
    const stepMatch = item.match(/(?:^|\[|\b)(?:step|stepIndex|step_id|\u6b65\u9aa4)\s*[:#=]?\s*(\d+)/i);
    if (stepMatch && validStepIndexes.has(Number(stepMatch[1]))) {
      const detailStart = (stepMatch.index || 0) + stepMatch[0].length;
      const detail = item.slice(detailStart).replace(/^[\]\s:;,.\-—]+/, '').trim();
      return [`[step:${Number(stepMatch[1])}]${detail ? ` ${detail}` : ''}`];
    }
    const screenshotMatch = item.match(/^\s*\[screenshot\s*:\s*(.+?)\s*\]/i);
    if (!screenshotMatch) return [];
    const path = screenshotMatch[1].trim();
    return validScreenshotPaths.has(path)
      ? [`[screenshot:${path}] ${item.slice(screenshotMatch[0].length).trim()}`.trim()]
      : [];
  });
}

function reportStateStep(execution: InteractiveBrowserTurnResult) {
  return [...execution.newSteps].reverse().find((step) => (
    step.tools?.some((tool) => tool.name === 'reportState' && tool.ok !== false)
  ));
}

export function fallbackGroundedEvidence(execution: InteractiveBrowserTurnResult) {
  const concludingStep = reportStateStep(execution);
  const observableStep = [...execution.newSteps].reverse().find((step) => (
    step.status === 'passed'
    && Boolean(step.actual?.trim() || step.observation?.trim() || step.findings?.length)
  ));
  const step = concludingStep || observableStep;
  const evidence = step
    ? [`[step:${step.index}] ${step.actual || step.observation || step.action}`]
    : [];
  const screenshot = executionScreenshotPaths(execution).at(-1);
  if (screenshot) evidence.push(`[screenshot:${screenshot}] 执行后页面截图`);
  return evidence;
}

export function fallbackVerificationVerdict(
  target: TargetLeafNode,
  execution: InteractiveBrowserTurnResult,
): VerificationVerdict {
  const concludingStep = reportStateStep(execution);
  const hasGroundedConclusion = Boolean(concludingStep);
  const criterionStatus: 'passed' | 'failed' | 'inconclusive' = execution.status === 'failed'
    ? 'failed'
    : execution.status === 'passed' && hasGroundedConclusion
      ? 'passed'
      : 'inconclusive';
  const evidence = criterionStatus === 'inconclusive' ? [] : fallbackGroundedEvidence(execution);
  return {
    status: execution.status === 'blocked'
      ? 'blocked'
      : criterionStatus,
    summary: execution.reply || '结构化验证输出无法解析，已根据执行器的明确结论和真实证据生成保守结果。',
    ...(criterionStatus === 'passed' ? {} : {
      failureReason: execution.reply || '结构化验证输出无法解析，且缺少可以确定结论的执行证据。',
    }),
    criteria: target.successCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: criterionStatus,
      observation: execution.reply || concludingStep?.actual || (
        criterionStatus === 'inconclusive'
          ? '缺少可以确定该标准的执行结论。'
          : `执行器明确报告目标${criterionStatus === 'passed' ? '通过' : '失败'}。`
      ),
      evidence,
    })),
    outputs: {},
  };
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
  let verdict: VerificationVerdict;
  try {
    const result = await generateObject({
      model: getModel(),
      schema: targetVerificationSchema,
      schemaName: 'target_execution_verification',
      schemaDescription: '基于真实浏览器步骤和截图的目标验证结果。',
      experimental_repairText: async ({ text }) => repairTargetVerificationText(text),
      temperature: 0,
      abortSignal: input.abortSignal,
      messages: [{ role: 'user', content }],
    });
    verdict = result.object;
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    // A formatting error must not turn a successfully observed browser target
    // into an execution failure. Fall back only to explicit reportState or
    // captured page evidence; otherwise the result remains inconclusive.
    verdict = fallbackVerificationVerdict(target, execution);
  }
  if (!verdict.criteria.length) {
    const fallback = fallbackVerificationVerdict(target, execution);
    verdict = {
      ...verdict,
      criteria: fallback.criteria,
      outputs: Object.keys(verdict.outputs).length ? verdict.outputs : fallback.outputs,
    };
  }
  const byCriterion = new Map(verdict.criteria.map((item) => [item.criterionId, item]));
  const validStepIndexes = new Set(execution.newSteps.map((step) => step.index));
  const validScreenshotPaths = new Set(screenshotPaths);
  const criteria = target.successCriteria.map((criterion, criterionIndex) => {
    const returned = byCriterion.get(criterion.id)
      || (verdict.criteria.length === target.successCriteria.length ? verdict.criteria[criterionIndex] : undefined);
    if (!returned) return {
      criterionId: criterion.id,
      status: 'inconclusive' as const,
      observation: '验证 Agent 未返回该标准的判断。',
      evidence: [],
    };
    let evidence = groundedCriterionEvidence(returned.evidence, validStepIndexes, validScreenshotPaths);
    if (returned.status !== 'inconclusive' && !evidence.length) {
      evidence = fallbackGroundedEvidence(execution);
    }
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
