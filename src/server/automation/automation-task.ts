import type { AutomationCaseRecord } from './automation.schema';

/** Old recordings contribute intent only. Tool inputs are never executed or copied into the task. */
export function automationTaskGuidance(task: Pick<AutomationCaseRecord, 'guidance' | 'operations'>) {
  if (task.guidance !== undefined) return task.guidance.trim();
  return [...new Set(task.operations.map((operation) => (
    operation.sourceStepAction || operation.reason || ''
  ).trim()).filter(Boolean))].map((line, index) => `${index + 1}. ${line}`).join('\n');
}

export function automationTaskInstruction(task: AutomationCaseRecord) {
  return [
    '你正在执行一次已由用户配置并触发的自动化任务。由你全程选择工具、观察结果并推进任务，直到完成或明确无法继续。',
    `任务名称：${task.title}`,
    `任务目标：\n${task.instruction}`,
    task.targetUrl && task.targetUrl !== 'about:blank' ? `起始网址：${task.targetUrl}` : '',
    `操作指引：\n${automationTaskGuidance(task) || '根据目标和当前事实自行安排操作。'}`,
    '操作指引描述的是工作方法。根据本次实际情况选择工具与具体参数；发现操作失败时自行调整，不沿用历史执行结果作为本次完成证据。',
    `完成条件：\n${task.completionCriteria?.trim() || '完整实现任务目标，并检查实际结果符合用户要求。'}`,
    '逐项检查完成条件；仍可处理的缺口继续执行。只有条件已满足才能报告 passed；遇到缺少信息、登录验证或人工介入才能解决的问题时报告 blocked，并说明已完成部分及阻塞原因。无法完成则报告 failed。',
    `输出要求：\n${task.outputRequirements?.trim() || '用中文输出本次任务的实际结果、完成情况及必要证据；如有文件，提供可访问的产物链接。'}`,
    '最终回复应直接交付内容，不要仅给计划或宣称完成。不得虚构数据、产物或完成证据。',
  ].filter(Boolean).join('\n\n');
}
