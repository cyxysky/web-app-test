export type BrowserChatSessionLifecycleStatus = 'idle' | 'running' | 'closed' | 'error';

export type BrowserChatSessionLifecycleState<TConfirmation> = {
  status: BrowserChatSessionLifecycleStatus;
  busy: boolean;
  updatedAt: string;
  error?: string;
  pendingToolConfirmation?: TConfirmation;
  activeAssistantMessageId?: string;
  activeAbortController?: AbortController;
};

export type BrowserChatSessionTransition<TConfirmation> =
  | { type: 'turnStarted'; assistantMessageId: string; abortController: AbortController; at: string }
  | { type: 'turnFinished'; at: string; error?: string; interrupted?: boolean }
  | { type: 'turnBlocked'; at: string }
  | { type: 'turnRuntimeReleased'; assistantMessageId: string; abortController: AbortController }
  | { type: 'sessionClosed'; at: string }
  | { type: 'sessionRecovered'; at: string }
  | { type: 'confirmationPending'; confirmation: TConfirmation; at: string }
  | { type: 'confirmationCleared'; at?: string };

export function transitionBrowserChatSession<TConfirmation>(
  session: BrowserChatSessionLifecycleState<TConfirmation>,
  transition: BrowserChatSessionTransition<TConfirmation>,
) {
  switch (transition.type) {
    case 'turnStarted':
      session.status = 'running';
      session.busy = true;
      session.error = undefined;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = transition.assistantMessageId;
      session.activeAbortController = transition.abortController;
      session.updatedAt = transition.at;
      break;
    case 'turnFinished':
      session.status = transition.error && !transition.interrupted ? 'error' : 'idle';
      session.busy = false;
      session.error = transition.interrupted ? undefined : transition.error;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = transition.at;
      break;
    case 'turnBlocked':
      session.status = 'idle';
      session.busy = false;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = transition.at;
      break;
    case 'turnRuntimeReleased':
      if (session.activeAssistantMessageId === transition.assistantMessageId) {
        session.activeAssistantMessageId = undefined;
      }
      if (session.activeAbortController === transition.abortController) {
        session.activeAbortController = undefined;
      }
      break;
    case 'sessionClosed':
      session.status = 'closed';
      session.busy = false;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = transition.at;
      break;
    case 'sessionRecovered':
      if (session.busy) throw new Error('A busy browser-chat session cannot be recovered to idle.');
      session.status = 'idle';
      session.error = undefined;
      session.updatedAt = transition.at;
      break;
    case 'confirmationPending':
      if (!session.busy || session.status !== 'running') {
        throw new Error('A tool confirmation can only be requested by an active browser-chat turn.');
      }
      session.pendingToolConfirmation = transition.confirmation;
      session.updatedAt = transition.at;
      break;
    case 'confirmationCleared':
      session.pendingToolConfirmation = undefined;
      if (transition.at) session.updatedAt = transition.at;
      break;
  }
  return session;
}
