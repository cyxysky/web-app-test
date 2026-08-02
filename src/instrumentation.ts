type SchedulerBootstrapState = {
  attempts: number;
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const schedulerBootstrapGlobal = globalThis as typeof globalThis & {
  __webpilotSchedulerBootstrap?: SchedulerBootstrapState;
};

function schedulerBootstrapUrl() {
  const configuredOrigin = String(process.env.WEBPILOT_INTERNAL_ORIGIN || '').trim();
  const port = Number(process.env.PORT || 3000);
  const origin = configuredOrigin || `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3000}`;
  const rawBasePath = String(
    process.env.NEXT_PUBLIC_WEBPILOT_BASE_PATH
    || process.env.WEBPILOT_BASE_PATH
    || '',
  ).trim().replace(/^\/+|\/+$/g, '');
  const basePath = rawBasePath ? `/${rawBasePath}` : '';
  return new URL(`${basePath}/api/automation/scheduler`, origin);
}

function scheduleBootstrapAttempt(state: SchedulerBootstrapState, delay: number) {
  if (state.started || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void fetch(schedulerBootstrapUrl(), {
      method: 'POST',
      cache: 'no-store',
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.started = true;
    }).catch((error: unknown) => {
      state.attempts += 1;
      if (state.attempts === 5 || state.attempts % 30 === 0) {
        console.warn('[automation-bootstrap] Scheduler API is not ready yet.', error);
      }
      scheduleBootstrapAttempt(state, Math.min(10_000, 250 * (state.attempts + 1)));
    });
  }, delay);
  (state.timer as NodeJS.Timeout).unref?.();
}

export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const state = schedulerBootstrapGlobal.__webpilotSchedulerBootstrap ??= {
    attempts: 0,
    started: false,
  };
  scheduleBootstrapAttempt(state, 0);
}
