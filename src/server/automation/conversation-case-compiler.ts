import type { BrowserChatMessage, BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import type { StepExecutionResult, StepToolCall } from '@/server/ai/schemas/runtime.schema';
import type { AutomationOperationRecord, CreateAutomationCaseInput } from './automation.schema';

export type ConversationCaseCompilerInput = {
  session: BrowserChatSessionSnapshot;
  assistantMessageId: string;
  userId?: string | number;
  title?: string;
  description?: string;
};

export type CompiledConversationCase = CreateAutomationCaseInput;

const nonReplayableResultPattern = /(?:skipped before execution|cancel(?:led|ed)|canceled|未执行|取消|已跳过)/i;

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function idText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function resultText(tool: StepToolCall) {
  const rawActual = tool.rawResult && typeof tool.rawResult === 'object' && !Array.isArray(tool.rawResult)
    ? text((tool.rawResult as { actual?: unknown }).actual)
    : '';
  return text(tool.result) || rawActual;
}

function recordedStatus(tool: StepToolCall): 'passed' | 'failed' | 'cancelled' {
  const result = resultText(tool);
  if (nonReplayableResultPattern.test(result)) return 'cancelled';
  return tool.ok === true ? 'passed' : 'failed';
}

function isRealTool(tool: StepToolCall) {
  const name = text(tool.name);
  return Boolean(name && name !== 'reportState' && name !== 'answer');
}

function sourceStepsForMessage(session: BrowserChatSessionSnapshot, message: BrowserChatMessage) {
  const declaredIndexes = new Set((message.stepIndexes || []).filter(Number.isFinite));
  return session.steps
    .filter((step) => step.messageId === message.id || declaredIndexes.has(step.index))
    .sort((left, right) => left.index - right.index);
}

function precedingUserMessage(messages: BrowserChatMessage[], assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return undefined;
}

function operationFromTool(
  step: StepExecutionResult,
  tool: StepToolCall,
  sourceToolIndex: number,
  operationIndex: number,
): AutomationOperationRecord {
  const status = recordedStatus(tool);
  const recordedResult = resultText(tool);
  return {
    index: operationIndex,
    name: tool.name,
    input: tool.input,
    reason: tool.reason,
    delayBeforeMs: 0,
    waitForManual: tool.name === 'waitForHumanVerification',
    sourceStepIndex: step.index,
    sourceStepAction: step.action,
    sourceStepExpected: step.expected,
    sourceToolIndex,
    recordedStatus: status,
    recordedResult: recordedResult || undefined,
    replayable: status === 'passed' && tool.name !== 'waitForHumanVerification',
  };
}

/**
 * Compile the browser tools owned by one assistant message into a deterministic
 * automation case. Failed and cancelled tools remain as non-replayable
 * operations so the runner can hand their diagnostics to the repair Agent.
 */
export function compileConversationCase(input: ConversationCaseCompilerInput): CompiledConversationCase {
  const assistantIndex = input.session.messages.findIndex((message) => (
    message.id === input.assistantMessageId && message.role === 'assistant'
  ));
  if (assistantIndex < 0) throw new Error('Selected assistant message was not found in the browser-chat session.');

  const assistantMessage = input.session.messages[assistantIndex];
  const userMessage = precedingUserMessage(input.session.messages, assistantIndex);
  const instruction = text(userMessage?.content);
  if (!instruction) throw new Error('Selected assistant message has no preceding user instruction to compile.');

  const sourceSteps = sourceStepsForMessage(input.session, assistantMessage);
  const operations: AutomationOperationRecord[] = [];
  for (const step of sourceSteps) {
    for (let toolIndex = 0; toolIndex < (step.tools || []).length; toolIndex += 1) {
      const tool = step.tools?.[toolIndex];
      if (!tool || !isRealTool(tool)) continue;
      operations.push(operationFromTool(step, tool, toolIndex, operations.length + 1));
    }
  }

  const selectedTitle = text(input.title) || text(input.session.title) || instruction.slice(0, 80);
  const sourceMessageIds = [userMessage?.id, assistantMessage.id].filter((id): id is string => Boolean(id));
  return {
    userId: idText(input.userId) || idText(input.session.userId) || '1',
    title: selectedTitle,
    description: text(input.description) || undefined,
    sourceSessionId: input.session.id,
    sourceMessageIds,
    targetUrl: text(input.session.targetUrl) || 'about:blank',
    instruction,
    mode: input.session.mode,
    operations,
  };
}
