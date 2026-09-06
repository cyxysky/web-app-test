import type { BrowserChatMessage, BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import type { CreateAutomationCaseInput } from './automation.schema';

export type ConversationMessagesCaseCompilerInput = {
  session: BrowserChatSessionSnapshot;
  assistantMessageIds: string[];
  userId?: string | number;
  title?: string;
  description?: string;
};
export type CompiledConversationCase = CreateAutomationCaseInput;

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function precedingUserMessage(messages: BrowserChatMessage[], assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return undefined;
}

/** Save task intent and operating guidance, never executable tool recordings. */
export function compileConversationMessagesCase(input: ConversationMessagesCaseCompilerInput): CompiledConversationCase {
  const requestedIds = [...new Set(input.assistantMessageIds.map((item) => item.trim()).filter(Boolean))];
  if (!requestedIds.length) throw new Error('Select at least one assistant message to compile.');
  const requested = new Set(requestedIds);
  const selected = input.session.messages.filter((message) => message.role === 'assistant' && requested.has(message.id));
  if (selected.length !== requestedIds.length) throw new Error('One or more selected assistant messages were not found in the browser-chat session.');
  if (selected.some((message) => message.status === 'running')) throw new Error('Wait for all selected assistant messages to finish before compiling a task.');

  const sourceMessageIds: string[] = [];
  const instructions: string[] = [];
  const guidance: string[] = [];
  const criteria: string[] = [];
  input.session.messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !requested.has(message.id)) return;
    const userMessage = precedingUserMessage(input.session.messages, index);
    const instruction = text(userMessage?.content);
    if (!instruction) return;
    sourceMessageIds.push(userMessage!.id, message.id);
    instructions.push(instruction);
    const indexes = new Set(message.stepIndexes || []);
    for (const step of [...input.session.steps].sort((a, b) => a.index - b.index)) {
      if (step.messageId !== message.id && !indexes.has(step.index)) continue;
      if (text(step.action)) guidance.push(text(step.action));
      if (text(step.expected)) criteria.push(text(step.expected));
    }
  });
  if (!instructions.length) throw new Error('Selected messages have no task instruction to reuse.');
  const numbered = (lines: string[]) => [...new Set(lines)].map((line, index) => `${index + 1}. ${line}`).join('\n');
  return {
    userId: String(input.userId ?? input.session.userId ?? '1').trim() || '1',
    title: text(input.title) || text(input.session.title) || instructions[0].slice(0, 80),
    description: text(input.description) || undefined,
    sourceSessionId: input.session.id,
    sourceMessageIds: [...new Set(sourceMessageIds)],
    targetUrl: text(input.session.targetUrl) || 'about:blank',
    instruction: instructions.length === 1 ? instructions[0] : numbered(instructions),
    guidance: numbered(guidance),
    completionCriteria: numbered(criteria),
    outputRequirements: '输出本次任务的实际结果、完成情况及必要证据；如有文件，提供可访问的产物链接。',
    operations: [],
  };
}
