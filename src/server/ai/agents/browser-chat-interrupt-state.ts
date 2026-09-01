export type InterruptibleBrowserChatRuntime = {
  activeAbortController?: AbortController;
  activeAssistantMessageId?: string;
  pendingToolConfirmation?: unknown;
  busy: boolean;
  status: 'idle' | 'running' | 'closed' | 'error';
  turnState?: 'idle' | 'running' | 'awaiting_confirmation' | 'awaiting_human' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'closed';
  error?: string;
  updatedAt: string;
};

export type RegisteredBrowserChatTurn<TSession> = {
  session: TSession;
  assistantMessageId: string;
  abortController: AbortController;
  hardTimeout?: ReturnType<typeof setTimeout>;
  hardTimeoutAt?: string;
};

export function registerBrowserChatTurn<TSession>(
  registry: Map<string, RegisteredBrowserChatTurn<TSession>>,
  sessionId: string,
  turn: RegisteredBrowserChatTurn<TSession>,
  options: { timeoutMs?: number; timeoutMessage?: string } = {},
) {
  const previous = registry.get(sessionId);
  if (previous?.hardTimeout) clearTimeout(previous.hardTimeout);
  const timeoutMs = Number(options.timeoutMs);
  const registered = { ...turn };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    registered.hardTimeoutAt = new Date(Date.now() + timeoutMs).toISOString();
    registered.hardTimeout = setTimeout(() => {
      if (registry.get(sessionId) !== registered || registered.abortController.signal.aborted) return;
      registered.abortController.abort(new Error(
        options.timeoutMessage || `Browser chat turn exceeded its ${Math.round(timeoutMs / 60_000)} minute hard limit.`,
      ));
    }, timeoutMs);
    registered.hardTimeout.unref?.();
  }
  registry.set(sessionId, registered);
}

export function registeredBrowserChatTurnIsActive<TSession>(
  registry: Map<string, RegisteredBrowserChatTurn<TSession>>,
  sessionId: string,
  session: TSession,
  assistantMessageId: string,
  abortController: AbortController,
) {
  const registered = registry.get(sessionId);
  return registered?.session === session
    && registered.assistantMessageId === assistantMessageId
    && registered.abortController === abortController
    && !abortController.signal.aborted;
}

export function clearRegisteredBrowserChatTurn<TSession>(
  registry: Map<string, RegisteredBrowserChatTurn<TSession>>,
  sessionId: string,
  assistantMessageId: string,
  abortController: AbortController,
) {
  const registered = registry.get(sessionId);
  if (
    registered?.assistantMessageId !== assistantMessageId
    || registered.abortController !== abortController
  ) return false;
  if (registered.hardTimeout) clearTimeout(registered.hardTimeout);
  registry.delete(sessionId);
  return true;
}

export function revokeRegisteredBrowserChatTurn<TSession>(
  registry: Map<string, RegisteredBrowserChatTurn<TSession>>,
  sessionId: string,
  reason: Error,
) {
  const registered = registry.get(sessionId);
  if (!registered) return undefined;
  if (registered.hardTimeout) clearTimeout(registered.hardTimeout);
  registry.delete(sessionId);
  const abortDispatched = !registered.abortController.signal.aborted;
  if (abortDispatched) registered.abortController.abort(reason);
  return { ...registered, abortDispatched };
}

export function revokeRegisteredBrowserChatTurnByAssistantMessageId<TSession>(
  registry: Map<string, RegisteredBrowserChatTurn<TSession>>,
  sessionId: string,
  assistantMessageId: string,
  reason: Error,
) {
  const registered = registry.get(sessionId);
  if (registered?.assistantMessageId !== assistantMessageId) return undefined;
  return revokeRegisteredBrowserChatTurn(registry, sessionId, reason);
}

export function racePromiseWithAbort<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new Error('Operation aborted.');
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Revoke a turn synchronously, then dispatch abort without waiting for the
 * underlying model request, browser tool, or child Agent to settle.
 */
export function revokeBrowserChatTurn(
  session: InterruptibleBrowserChatRuntime,
  timestamp: string,
  reason: Error,
) {
  const assistantMessageId = session.activeAssistantMessageId;
  const abortController = session.activeAbortController;

  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.pendingToolConfirmation = undefined;
  session.busy = false;
  if (session.status !== 'closed') session.status = 'idle';
  if (session.status !== 'closed') session.turnState = 'interrupted';
  session.error = undefined;
  session.updatedAt = timestamp;

  const abortDispatched = Boolean(abortController && !abortController.signal.aborted);
  if (abortDispatched) abortController!.abort(reason);
  return { abortController, abortDispatched, assistantMessageId };
}

export function runtimeSnapshotIsNewer(runtimeUpdatedAt: string, persistedUpdatedAt: string) {
  const runtimeTime = Date.parse(runtimeUpdatedAt);
  const persistedTime = Date.parse(persistedUpdatedAt);
  return Number.isFinite(runtimeTime) && Number.isFinite(persistedTime) && runtimeTime > persistedTime;
}
