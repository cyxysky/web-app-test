import type { ModelMessage } from 'ai';

export type RuntimeRetryState<TMessage extends ModelMessage = ModelMessage> = {
  agentStepOffset: number;
  imagePaths: string[];
  messages: TMessage[];
};

export function cloneRuntimeRetryState<TMessage extends ModelMessage>(
  state: RuntimeRetryState<TMessage>,
): RuntimeRetryState<TMessage> {
  return {
    messages: [...state.messages],
    imagePaths: [...state.imagePaths],
    agentStepOffset: state.agentStepOffset,
  };
}
