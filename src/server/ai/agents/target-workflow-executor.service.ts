import { generateText } from 'ai';
import {
  executeInteractiveBrowserTurn,
  type BrowserToolConfirmationDecision,
  type BrowserToolConfirmationRequest,
  type InteractiveBrowserTurnMessage,
} from '@/server/ai/agents/browser-chat-executor.agent';
import { verifyTargetExecution } from '@/server/ai/agents/target-workflow-verifier.agent';
import { getModel } from '@/server/ai/model';
import type { BrowserSession } from '@/server/browser/browser-session';
import type { StepExecutionResult } from '@/server/ai/schemas/test-case.schema';
import {
  targetPlanNodeMap,
  validateTargetPlanStructure,
  type TargetActor,
  type TargetFlowNode,
  type TargetLeafNode,
  type TargetResult,
  type TargetWorkflowRun,
} from '@/server/ai/schemas/target-workflow.schema';

type ExecutionHooks = {
  getBrowser: (input: { actor?: TargetActor; laneId: string; target: TargetLeafNode }) => Promise<BrowserSession>;
  onRunChange: (run: TargetWorkflowRun) => void | Promise<void>;
  onSteps: (steps: StepExecutionResult[]) => void | Promise<void>;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  safetyMode?: 'strict' | 'full';
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onDebug?: (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
};

type NodeOutcome = 'passed' | 'failed' | 'inconclusive' | 'blocked' | 'cancelled';

function now() {
  return new Date().toISOString();
}

function executionStopped(hooks: ExecutionHooks) {
  return Boolean(hooks.abortSignal?.aborted || (hooks.shouldContinue && !hooks.shouldContinue()));
}

function resultOutcome(result: TargetResult): NodeOutcome {
  if (result.status === 'pending' || result.status === 'running') return 'inconclusive';
  return result.status;
}

function combineOutcomes(outcomes: NodeOutcome[]): NodeOutcome {
  if (outcomes.some((status) => status === 'cancelled')) return 'cancelled';
  if (outcomes.some((status) => status === 'failed')) return 'failed';
  if (outcomes.some((status) => status === 'blocked')) return 'blocked';
  if (outcomes.some((status) => status === 'inconclusive')) return 'inconclusive';
  return 'passed';
}

function targetInstruction(target: TargetLeafNode, actor: TargetActor | undefined, dependencyResults: TargetResult[]) {
  return [
    '你正在执行流程树中的一个独立测试目标。只处理当前目标，不要扩展到其他目标。',
    '必须实际操作或检查当前浏览器，并针对每条成功标准收集证据。工具调用成功本身不能证明业务结果。',
    '完成后使用 reportState 明确报告 passed、failed 或 blocked；证据不足时不要编造成功。',
    '',
    `当前目标：${target.title}`,
    `目标说明：${target.objective}`,
    `执行身份：${actor ? `${actor.name}（${actor.role}）` : '匿名会话'}`,
    `前置条件：${target.preconditions.length ? target.preconditions.join('；') : '[无]'}`,
    `成功标准：\n${target.successCriteria.map((criterion, index) => `${index + 1}. ${criterion.description}；证据要求：${criterion.evidenceRequirement}`).join('\n')}`,
    dependencyResults.length ? `前序目标输出：\n${JSON.stringify(dependencyResults.map((result) => ({
      targetId: result.targetId,
      status: result.status,
      outputs: result.outputs,
      summary: result.summary,
    })), null, 2)}` : '',
  ].filter(Boolean).join('\n');
}

function leafIdsBelow(node: TargetFlowNode, nodes: Map<string, TargetFlowNode>): string[] {
  if (node.type === 'target') return [node.id];
  return node.children.flatMap((childId) => {
    const child = nodes.get(childId);
    return child ? leafIdsBelow(child, nodes) : [];
  });
}

function fallbackRunSummary(run: TargetWorkflowRun) {
  const plan = run.plan;
  if (!plan) return '目标测试没有可总结的计划。';
  const results = Object.values(run.results);
  const counts = {
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    inconclusive: results.filter((item) => item.status === 'inconclusive').length,
    blocked: results.filter((item) => item.status === 'blocked').length,
    cancelled: results.filter((item) => item.status === 'cancelled').length,
  };
  const problemLines = results
    .filter((item) => item.status !== 'passed')
    .map((item) => {
      const title = plan.nodes.find((node) => node.id === item.targetId)?.title || item.targetId;
      return `- ${title}：${item.status}；${item.failureReason || item.summary || '未提供原因'}`;
    });
  return [
    `目标测试已完成：通过 ${counts.passed}，失败 ${counts.failed}，无法判断 ${counts.inconclusive}，被阻断 ${counts.blocked}，取消 ${counts.cancelled}。`,
    problemLines.length ? `\n未通过目标：\n${problemLines.join('\n')}` : '\n所有目标均已通过。',
  ].join('');
}

async function summarizeRun(run: TargetWorkflowRun, abortSignal?: AbortSignal) {
  const plan = run.plan;
  if (!plan) return fallbackRunSummary(run);
  const results = Object.values(run.results);
  const counts = {
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    inconclusive: results.filter((item) => item.status === 'inconclusive').length,
    blocked: results.filter((item) => item.status === 'blocked').length,
    cancelled: results.filter((item) => item.status === 'cancelled').length,
  };
  try {
    const generated = await generateText({
      model: getModel(),
      temperature: 0.1,
      abortSignal,
      prompt: [
        '你是目标测试的主总结 Agent。所有子目标已经结束。请用简洁中文 Markdown 汇总，不得改变结构化结果的状态，不得编造证据。',
        '先给总体结论，再列出失败、无法判断和被阻断目标及原因，最后列出最重要的证据与建议。',
        `计划：${plan.title}`,
        `统计：${JSON.stringify(counts)}`,
        `结果：\n${JSON.stringify(results.map((item) => ({
          targetId: item.targetId,
          title: plan.nodes.find((node) => node.id === item.targetId)?.title,
          status: item.status,
          summary: item.summary,
          failureReason: item.failureReason,
          criteria: item.criteria,
          evidence: item.evidence,
        })), null, 2)}`,
      ].join('\n'),
    });
    return (generated.text.trim() || fallbackRunSummary(run)).slice(0, 20_000);
  } catch {
    return fallbackRunSummary(run).slice(0, 20_000);
  }
}

export async function executeTargetWorkflow(initialRun: TargetWorkflowRun, hooks: ExecutionHooks) {
  const plan = initialRun.plan;
  if (!plan) throw new Error('目标测试计划不存在');
  const structuralErrors = validateTargetPlanStructure(plan);
  if (structuralErrors.length) throw new Error(`目标测试计划结构无效：${structuralErrors.join('；')}`);
  const run: TargetWorkflowRun = {
    ...initialRun,
    plan,
    status: 'running',
    startedAt: initialRun.startedAt || now(),
    updatedAt: now(),
    results: { ...initialRun.results },
  };
  const nodes = targetPlanNodeMap(plan);
  const actors = new Map(plan.actors.map((actor) => [actor.id, actor]));
  const nodeOrder = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const laneTails = new Map<string, Promise<void>>();
  const laneConversations = new Map<string, InteractiveBrowserTurnMessage[]>();
  const workflowAbortController = new AbortController();
  const forwardExternalAbort = () => workflowAbortController.abort(hooks.abortSignal?.reason);
  if (hooks.abortSignal?.aborted) forwardExternalAbort();
  else hooks.abortSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
  const shouldContinueWorkflow = () => (
    !workflowAbortController.signal.aborted
    && (!hooks.shouldContinue || hooks.shouldContinue())
  );
  const throwIfWorkflowStopped = () => {
    if (!shouldContinueWorkflow()) {
      throw workflowAbortController.signal.reason || hooks.abortSignal?.reason || new Error('目标测试已中断');
    }
  };
  const cleanupAbortForwarder = () => hooks.abortSignal?.removeEventListener('abort', forwardExternalAbort);

  const publish = async () => {
    run.updatedAt = now();
    await hooks.onRunChange({ ...run, results: { ...run.results } });
  };

  const withLane = async <T>(laneKey: string, action: () => Promise<T>) => {
    const previous = laneTails.get(laneKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    laneTails.set(laneKey, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (laneTails.get(laneKey) === tail) laneTails.delete(laneKey);
    }
  };

  const withResourceLocks = async <T>(target: TargetLeafNode, action: () => Promise<T>) => {
    const keys = Array.from(new Set(target.resources
      .filter((resource) => resource.access === 'write')
      .map((resource) => resource.key.trim().toLowerCase())
      .filter(Boolean)))
      .sort();
    const acquire = (index: number): Promise<T> => (
      index >= keys.length
        ? action()
        : withLane(`resource:${keys[index]}`, () => acquire(index + 1))
    );
    return acquire(0);
  };

  const markBlocked = async (node: TargetFlowNode, blockedBy: string[], reason: string) => {
    throwIfWorkflowStopped();
    for (const targetId of leafIdsBelow(node, nodes)) {
      const target = nodes.get(targetId);
      if (!target || target.type !== 'target') continue;
      run.results[targetId] = {
        targetId,
        actorId: target.actorId,
        status: 'blocked',
        endedAt: now(),
        summary: reason,
        failureReason: reason,
        blockedBy,
        criteria: target.successCriteria.map((criterion) => ({
          criterionId: criterion.id,
          status: 'inconclusive',
          observation: reason,
          evidence: [],
        })),
        evidence: [],
        outputs: {},
      };
    }
    await publish();
  };

  const executeLeaf = async (
    target: TargetLeafNode,
    laneId: string,
    dependencyResults: TargetResult[],
  ): Promise<NodeOutcome> => {
    throwIfWorkflowStopped();
    const actor = target.actorId ? actors.get(target.actorId) : undefined;
    const laneKey = actor ? `actor:${actor.id}` : `lane:${laneId}`;
    return withLane(laneKey, () => withResourceLocks(target, async () => {
      throwIfWorkflowStopped();
      const startedAt = now();
      run.results[target.id] = {
        targetId: target.id,
        actorId: target.actorId,
        status: 'running',
        startedAt,
        criteria: [],
        evidence: [],
        outputs: {},
      };
      await publish();
      try {
        const browser = await hooks.getBrowser({ actor, laneId, target });
        throwIfWorkflowStopped();
        if (plan.targetUrl && !browser.hasNonBlankActivePage()) await browser.open(plan.targetUrl);
        const instruction = targetInstruction(target, actor, dependencyResults);
        const conversation = laneConversations.get(laneId) || [];
        const execution = await executeInteractiveBrowserTurn({
          session: browser,
          runId: `${run.id}_${target.id}`,
          initialStepIndex: ((nodeOrder.get(target.id) || 0) + 1) * 10_000,
          targetUrl: plan.targetUrl || browser.currentUrl() || 'about:blank',
          instruction,
          modelInstruction: instruction,
          conversation,
          mode: 'dom',
          safetyMode: hooks.safetyMode,
          completedSteps: [],
          abortSignal: workflowAbortController.signal,
          shouldContinue: shouldContinueWorkflow,
          requestToolConfirmation: hooks.requestToolConfirmation
            ? (request) => withLane('confirmation', () => hooks.requestToolConfirmation!(request))
            : undefined,
          onDebug: hooks.onDebug,
          onProgress: (step) => hooks.onSteps([step]),
        });
        const nextConversation: InteractiveBrowserTurnMessage[] = [
          ...conversation,
          { role: 'user', content: instruction },
          { role: 'assistant', content: execution.reply || `目标 ${target.title} 执行结束。` },
        ];
        laneConversations.set(laneId, nextConversation.slice(-12));
        await hooks.onSteps(execution.newSteps);
        throwIfWorkflowStopped();
        const endedAt = now();
        const verified = await verifyTargetExecution({
          target,
          actorName: actor?.name,
          execution,
          startedAt,
          endedAt,
          abortSignal: workflowAbortController.signal,
        });
        throwIfWorkflowStopped();
        run.results[target.id] = verified;
        await publish();
        return resultOutcome(verified);
      } catch (error) {
        if (!shouldContinueWorkflow()) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const failed: TargetResult = {
          targetId: target.id,
          actorId: target.actorId,
          status: 'failed',
          startedAt,
          endedAt: now(),
          summary: `目标执行异常：${reason}`,
          failureReason: reason,
          criteria: target.successCriteria.map((criterion) => ({
            criterionId: criterion.id,
            status: 'inconclusive',
            observation: '执行或证据验证发生异常，无法完成该项判断。',
            evidence: [],
          })),
          evidence: [],
          outputs: {},
        };
        run.results[target.id] = failed;
        await publish();
        return 'failed';
      }
    }));
  };

  const executeNode = async (
    nodeId: string,
    laneId: string,
    dependencyResults: TargetResult[],
  ): Promise<NodeOutcome> => {
    throwIfWorkflowStopped();
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`目标流程节点不存在：${nodeId}`);
    if (node.type === 'target') return executeLeaf(node, laneId, dependencyResults);
    if (node.type === 'sequence') {
      const outcomes: NodeOutcome[] = [];
      const blockers: string[] = [];
      let availableDependencies = [...dependencyResults];
      for (let index = 0; index < node.children.length; index += 1) {
        const childId = node.children[index];
        const child = nodes.get(childId);
        if (!child) throw new Error(`目标流程节点不存在：${childId}`);
        if (blockers.length && !(child.type === 'sequence' && child.alwaysRun)) {
          await markBlocked(child, blockers, `前置目标 ${blockers.join('、')} 未成功，当前目标未执行。`);
          outcomes.push('blocked');
          availableDependencies = [
            ...availableDependencies,
            ...leafIdsBelow(child, nodes).map((id) => run.results[id]).filter((result): result is TargetResult => Boolean(result)),
          ];
          continue;
        }
        const outcome = await executeNode(childId, laneId, availableDependencies);
        outcomes.push(outcome);
        availableDependencies = [
          ...availableDependencies,
          ...leafIdsBelow(child, nodes).map((id) => run.results[id]).filter((result): result is TargetResult => Boolean(result)),
        ];
        if (outcome !== 'passed') blockers.push(...leafIdsBelow(child, nodes).filter((id) => run.results[id]?.status !== 'passed'));
      }
      return combineOutcomes(outcomes);
    }

    const outcomes: NodeOutcome[] = new Array(node.children.length);
    let cursor = 0;
    const workerCount = Math.min(node.maxConcurrency || node.children.length, node.children.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        throwIfWorkflowStopped();
        const index = cursor;
        cursor += 1;
        if (index >= node.children.length) return;
        try {
          outcomes[index] = await executeNode(node.children[index], `${laneId}.p${index + 1}`, [...dependencyResults]);
        } catch (error) {
          if (!workflowAbortController.signal.aborted) workflowAbortController.abort(error);
          throw error;
        }
      }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (rejected) throw rejected.reason;
    return combineOutcomes(outcomes);
  };

  try {
    await publish();
    await executeNode(plan.rootNodeId, 'root', []);
    throwIfWorkflowStopped();
    run.status = 'summarizing';
    await publish();
    run.summary = await summarizeRun(run, workflowAbortController.signal);
    throwIfWorkflowStopped();
    run.status = 'completed';
    run.endedAt = now();
    await publish();
    cleanupAbortForwarder();
    return run;
  } catch (error) {
    cleanupAbortForwarder();
    const cancelled = executionStopped(hooks);
    run.status = cancelled ? 'cancelled' : 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    run.endedAt = now();
    if (cancelled) {
      for (const node of plan.nodes) {
        if (node.type !== 'target') continue;
        const previous = run.results[node.id];
        if (previous && !['pending', 'running'].includes(previous.status)) continue;
        run.results[node.id] = {
          targetId: node.id,
          actorId: node.actorId,
          status: 'cancelled',
          startedAt: previous?.startedAt,
          endedAt: now(),
          summary: '目标测试执行已中断。',
          failureReason: run.error,
          criteria: node.successCriteria.map((criterion) => ({
            criterionId: criterion.id,
            status: 'inconclusive',
            observation: '执行已中断，未获得完整证据。',
            evidence: [],
          })),
          evidence: previous?.evidence || [],
          outputs: previous?.outputs || {},
          stepIndexes: previous?.stepIndexes,
        };
      }
    }
    await publish();
    throw error;
  }
}
