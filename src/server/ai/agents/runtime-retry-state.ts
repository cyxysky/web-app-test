import type { ModelMessage } from 'ai';

export type RuntimeRetryState<TMessage extends ModelMessage = ModelMessage> = {
  agentStepOffset: number;
  imagePaths: string[];
  messages: TMessage[];
};

export type RuntimeFailureRecovery<TMessage extends ModelMessage = ModelMessage> = {
  agentStepOffset: number;
  messages: TMessage[];
  turnMessages: TMessage[];
};

const runtimeFailureRecoveryKey = 'runtimeFailureRecovery';

export function cloneRuntimeRetryState<TMessage extends ModelMessage>(
  state: RuntimeRetryState<TMessage>,
): RuntimeRetryState<TMessage> {
  return {
    messages: [...state.messages],
    imagePaths: [...state.imagePaths],
    agentStepOffset: state.agentStepOffset,
  };
}

export function attachRuntimeFailureRecovery<TMessage extends ModelMessage>(
  error: unknown,
  state: RuntimeRetryState<TMessage> | undefined,
  historicalMessageCount: number,
  fallbackTurnMessages: readonly TMessage[] = [],
  explicitTurnMessages?: readonly TMessage[],
) {
  if (!error || typeof error !== 'object' || !state?.messages.length) return;
  const offset = Math.max(0, Math.min(state.messages.length, Math.floor(historicalMessageCount)));
  const recoveredTurnMessages = state.messages.slice(offset);
  (error as Record<string, unknown>)[runtimeFailureRecoveryKey] = {
    agentStepOffset: state.agentStepOffset,
    messages: [...state.messages],
    turnMessages: explicitTurnMessages ? [...explicitTurnMessages] : recoveredTurnMessages.length
      ? recoveredTurnMessages
      : [...fallbackTurnMessages],
  } satisfies RuntimeFailureRecovery<TMessage>;
}

export function runtimeFailureRecoveryFromError<TMessage extends ModelMessage = ModelMessage>(
  error: unknown,
): RuntimeFailureRecovery<TMessage> | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const recovery = (error as Record<string, unknown>)[runtimeFailureRecoveryKey];
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return undefined;
  const record = recovery as Partial<RuntimeFailureRecovery<TMessage>>;
  if (!Array.isArray(record.messages) || !record.messages.length) return undefined;
  return {
    agentStepOffset: Number.isFinite(record.agentStepOffset) ? Number(record.agentStepOffset) : 0,
    messages: [...record.messages],
    turnMessages: Array.isArray(record.turnMessages) ? [...record.turnMessages] : [],
  };
}
