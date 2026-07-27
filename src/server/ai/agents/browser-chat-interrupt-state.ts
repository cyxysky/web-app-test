export type InterruptibleBrowserChatRuntime = {
  activeAbortController?: AbortController;
  activeAssistantMessageId?: string;
  pendingToolConfirmation?: unknown;
  busy: boolean;
  status: 'idle' | 'running' | 'closed' | 'error';
  error?: string;
  updatedAt: string;
};

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
