export type ManagedBrowserSession = {
  close: (options: { force: true }) => Promise<void>;
};

type BrowserSessionLifecycleState = {
  hooksInstalled: boolean;
  sessions: Set<ManagedBrowserSession>;
  shuttingDown?: Promise<void>;
};

const lifecycleState = ((globalThis as typeof globalThis & {
  __webPilotBrowserSessionLifecycleState?: BrowserSessionLifecycleState;
}).__webPilotBrowserSessionLifecycleState ??= {
  hooksInstalled: false,
  sessions: new Set<ManagedBrowserSession>(),
});

export function registerBrowserSession(session: ManagedBrowserSession) {
  lifecycleState.sessions.add(session);
}

export function unregisterBrowserSession(session: ManagedBrowserSession) {
  lifecycleState.sessions.delete(session);
}

export async function closeManagedBrowserSessions() {
  if (lifecycleState.shuttingDown) return lifecycleState.shuttingDown;
  lifecycleState.shuttingDown = (async () => {
    const sessions = [...lifecycleState.sessions];
    await Promise.allSettled(sessions.map((session) => session.close({ force: true })));
    lifecycleState.sessions.clear();
  })().finally(() => {
    lifecycleState.shuttingDown = undefined;
  });
  return lifecycleState.shuttingDown;
}

export function installBrowserSessionShutdownHooks() {
  if (lifecycleState.hooksInstalled) return;
  lifecycleState.hooksInstalled = true;
  const shutdown = () => {
    const forceExitTimer = setTimeout(() => process.exit(1), 8_000);
    forceExitTimer.unref?.();
    void closeManagedBrowserSessions().finally(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform !== 'win32') process.once('SIGHUP', shutdown);
}
