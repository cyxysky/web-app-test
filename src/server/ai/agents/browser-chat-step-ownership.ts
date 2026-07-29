import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';

type BrowserChatStepOwnerMessage = {
  id: string;
  role: 'user' | 'assistant';
  stepIndexes?: number[];
};

type BrowserChatStepOwnerLog = {
  messageId?: string;
  phase: string;
  stepIndex?: number;
};

export function attachBrowserChatStepOwners<TStep extends StepExecutionResult>(
  steps: TStep[],
  logs: BrowserChatStepOwnerLog[],
) {
  const ownerByStepIndex = new Map<number, string>();
  for (const log of logs) {
    if (!log.messageId || !Number.isFinite(log.stepIndex) || log.phase.startsWith('subagent:')) continue;
    ownerByStepIndex.set(log.stepIndex as number, log.messageId);
  }

  return steps.map((step) => {
    const messageId = ownerByStepIndex.get(step.index) || step.messageId;
    return messageId && messageId !== step.messageId ? { ...step, messageId } : step;
  });
}

export function alignBrowserChatMessageStepIndexes<TMessage extends BrowserChatStepOwnerMessage>(
  messages: TMessage[],
  steps: StepExecutionResult[],
) {
  const ownerByStepIndex = new Map<number, string>();
  const stepIndexesByMessageId = new Map<string, number[]>();
  for (const step of steps) {
    if (!step.messageId) continue;
    ownerByStepIndex.set(step.index, step.messageId);
    const indexes = stepIndexesByMessageId.get(step.messageId) || [];
    indexes.push(step.index);
    stepIndexesByMessageId.set(step.messageId, indexes);
  }

  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const retainedIndexes = (message.stepIndexes || []).filter((stepIndex) => {
      const owner = ownerByStepIndex.get(stepIndex);
      return !owner || owner === message.id;
    });
    const stepIndexes = Array.from(new Set([
      ...retainedIndexes,
      ...(stepIndexesByMessageId.get(message.id) || []),
    ])).sort((left, right) => left - right);
    return stepIndexes.length === message.stepIndexes?.length
      && stepIndexes.every((stepIndex, index) => stepIndex === message.stepIndexes?.[index])
      ? message
      : { ...message, stepIndexes };
  });
}
