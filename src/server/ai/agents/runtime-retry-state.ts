import type { ModelMessage } from 'ai';
import { cloneRuntimeObservationStore, type RuntimeObservationStore } from './runtime-observation';

export type RuntimeRetryState<TMessage extends ModelMessage = ModelMessage> = {
  agentStepOffset: number;
  imagePaths: string[];
  messages: TMessage[];
  observationStore?: RuntimeObservationStore;
};

export function cloneRuntimeRetryState<TMessage extends ModelMessage>(
  state: RuntimeRetryState<TMessage>,
): RuntimeRetryState<TMessage> {
  const observationStore = cloneRuntimeObservationStore(state.observationStore);
  return {
    messages: [...state.messages],
    imagePaths: [...state.imagePaths],
    agentStepOffset: state.agentStepOffset,
    ...(observationStore ? { observationStore } : {}),
  };
}
