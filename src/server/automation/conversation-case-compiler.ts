import type { BrowserChatMessage, BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import type { StepExecutionResult, StepToolCall } from '@/server/ai/schemas/runtime.schema';
import type { AutomationOperationRecord, CreateAutomationCaseInput } from './automation.schema';

export type ConversationMessagesCaseCompilerInput = {
  session: BrowserChatSessionSnapshot;
  assistantMessageIds: string[];
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
  return Boolean(name && name !== 'answer');
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

/** Compile selected completed assistant turns in one conversation into one case. */
export function compileConversationMessagesCase(input: ConversationMessagesCaseCompilerInput): CompiledConversationCase {
  const requestedIds = Array.from(new Set(input.assistantMessageIds.map((item) => item.trim()).filter(Boolean)));
  if (!requestedIds.length) throw new Error('Select at least one assistant message to compile.');
  const requestedIdSet = new Set(requestedIds);
  const operations: AutomationOperationRecord[] = [];
  const sourceMessageIds: string[] = [];
  const instructions: string[] = [];
  const usedTools = new Set<string>();
  const selectedMessages = input.session.messages.filter((message) => (
    message.role === 'assistant' && requestedIdSet.has(message.id)
  ));
  if (selectedMessages.length !== requestedIds.length) {
    throw new Error('One or more selected assistant messages were not found in the browser-chat session.');
  }
  if (selectedMessages.some((message) => message.status === 'running')) {
    throw new Error('Wait for all selected assistant messages to finish before compiling a case.');
  }

  input.session.messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' || !requestedIdSet.has(message.id)) return;
    const userMessage = precedingUserMessage(input.session.messages, messageIndex);
    const instruction = text(userMessage?.content);
    if (!instruction) return;

    let executableToolCount = 0;
    for (const step of sourceStepsForMessage(input.session, message)) {
      for (let toolIndex = 0; toolIndex < (step.tools || []).length; toolIndex += 1) {
        const tool = step.tools?.[toolIndex];
        const toolKey = `${step.index}:${toolIndex}`;
        if (!tool || !isRealTool(tool) || usedTools.has(toolKey)) continue;
        usedTools.add(toolKey);
        executableToolCount += 1;
        operations.push(operationFromTool(step, tool, toolIndex, operations.length + 1));
      }
    }
    if (!executableToolCount) return;
    if (userMessage?.id) sourceMessageIds.push(userMessage.id);
    sourceMessageIds.push(message.id);
    instructions.push(instruction);
  });

  if (!operations.length) throw new Error('Selected assistant messages have no executable completed steps.');
  const uniqueInstructions = Array.from(new Set(instructions));
  const instruction = uniqueInstructions.length === 1
    ? uniqueInstructions[0]
    : uniqueInstructions.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return {
    userId: idText(input.userId) || idText(input.session.userId) || '1',
    title: text(input.title) || text(input.session.title) || uniqueInstructions[0]?.slice(0, 80) || '浏览器自动化用例',
    description: text(input.description) || undefined,
    sourceSessionId: input.session.id,
    sourceMessageIds: Array.from(new Set(sourceMessageIds)),
    targetUrl: text(input.session.targetUrl) || 'about:blank',
    instruction,
    operations,
  };
}
