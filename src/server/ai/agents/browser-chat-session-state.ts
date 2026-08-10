export type BrowserChatSessionLifecycleStatus = 'idle' | 'running' | 'closed' | 'error';
export type BrowserChatTurnState =
  | 'idle'
  | 'running'
  | 'awaiting_confirmation'
  | 'awaiting_human'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'closed';

export type BrowserChatSessionLifecycleState<TConfirmation> = {
  status: BrowserChatSessionLifecycleStatus;
  turnState: BrowserChatTurnState;
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
  | { type: 'turnStopping'; at: string }
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
      session.turnState = 'running';
      session.busy = true;
      session.error = undefined;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = transition.assistantMessageId;
      session.activeAbortController = transition.abortController;
      session.updatedAt = transition.at;
      break;
    case 'turnFinished':
      session.status = transition.error && !transition.interrupted ? 'error' : 'idle';
      session.turnState = transition.interrupted
        ? 'interrupted'
        : transition.error
          ? 'failed'
          : 'completed';
      session.busy = false;
      session.error = transition.interrupted ? undefined : transition.error;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = transition.at;
      break;
    case 'turnBlocked':
      session.status = 'idle';
      session.turnState = 'awaiting_human';
      session.busy = false;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = transition.at;
      break;
    case 'turnStopping':
      if (session.status === 'closed') break;
      session.turnState = 'stopping';
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
      session.turnState = 'closed';
      session.busy = false;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = transition.at;
      break;
    case 'sessionRecovered':
      if (session.busy) throw new Error('A busy browser-chat session cannot be recovered to idle.');
      session.status = 'idle';
      session.turnState = 'idle';
      session.error = undefined;
      session.updatedAt = transition.at;
      break;
    case 'confirmationPending':
      if (!session.busy || session.status !== 'running') {
        throw new Error('A tool confirmation can only be requested by an active browser-chat turn.');
      }
      session.pendingToolConfirmation = transition.confirmation;
      session.turnState = 'awaiting_confirmation';
      session.updatedAt = transition.at;
      break;
    case 'confirmationCleared':
      session.pendingToolConfirmation = undefined;
      if (session.busy && session.status === 'running') session.turnState = 'running';
      if (transition.at) session.updatedAt = transition.at;
      break;
  }
  return session;
}

export function normalizeBrowserChatTurnState(input: {
  busy?: boolean;
  pendingToolConfirmation?: unknown;
  status?: BrowserChatSessionLifecycleStatus;
  turnState?: unknown;
}): BrowserChatTurnState {
  const allowed = new Set<BrowserChatTurnState>([
    'idle',
    'running',
    'awaiting_confirmation',
    'awaiting_human',
    'stopping',
    'completed',
    'failed',
    'interrupted',
    'closed',
  ]);
  if (allowed.has(input.turnState as BrowserChatTurnState)) return input.turnState as BrowserChatTurnState;
  if (input.status === 'closed') return 'closed';
  if (input.pendingToolConfirmation) return 'awaiting_confirmation';
  if (input.busy || input.status === 'running') return 'running';
  if (input.status === 'error') return 'failed';
  return 'idle';
}
