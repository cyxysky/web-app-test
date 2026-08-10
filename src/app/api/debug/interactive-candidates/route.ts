import { NextRequest } from 'next/server';
import { BrowserSession } from '@/server/browser/browser-session';
import { store } from '@/server/db/store';
import { apiError, apiJson } from '@/server/http/api-request';
import { requireDebugRouteAccess } from '@/server/http/debug-route-access';

type DebugInteractiveCandidateState = {
  session?: BrowserSession;
  runId?: string;
};

const debugState = ((globalThis as typeof globalThis & {
  __interactiveCandidateDebugState?: DebugInteractiveCandidateState;
}).__interactiveCandidateDebugState ??= {});

function boolParam(value: string | null, fallback: boolean) {
  if (value === null || value.trim() === '') return fallback;
  return /^(true|1|yes|on)$/i.test(value);
}

export async function GET(request: NextRequest) {
  try {
    requireDebugRouteAccess(request);
    const search = request.nextUrl.searchParams;
    const url = search.get('url') || 'https://www.bing.com/';
    const pause = boolParam(search.get('pause'), true);
    const serverPause = boolParam(search.get('serverPause'), false);
    const keepOpen = boolParam(search.get('keepOpen'), true);
    const includeScreenshot = boolParam(search.get('screenshot'), true);
    const reuse = boolParam(search.get('reuse'), false);
    const runId = `debug_interactive_candidates_${Date.now()}`;
    if (serverPause) {
      debugger;
    }
    store.applyRuntimeEnv();
    if (!reuse && debugState.session) {
      await debugState.session.close({ keepOpen: false }).catch(() => undefined);
      debugState.session = undefined;
      debugState.runId = undefined;
    }

    const session = reuse && debugState.session
      ? debugState.session
      : new BrowserSession('dom', {
          isMarked: true,
          runId,
          debugDevtools: true,
          preferExistingPage: false,
        });

    if (!reuse || !debugState.session) {
      if (serverPause) {
        debugger;
      }
      await session.start();
      debugState.session = session;
      debugState.runId = runId;
    }

    if (serverPause) {
      debugger;
    }
    const opened = await session.open(url);
    await session.waitForPage().catch(() => undefined);
    if (serverPause) {
      debugger;
    }
    const scan = await session.debugInteractiveCandidateScan({ pause, includeScreenshot, runId });
    if (serverPause) {
      debugger;
    }
    if (!keepOpen) {
      await session.close({ keepOpen: false }).catch(() => undefined);
      if (debugState.session === session) {
        debugState.session = undefined;
        debugState.runId = undefined;
      }
    }

    return apiJson(request, {
      ok: true,
      url,
      pause,
      serverPause,
      keepOpen,
      opened,
      runId,
      note: pause
        ? 'A debugger statement ran inside collectAiDomObservation() in the browser page VM. Resume in DevTools to let this request finish. Use serverPause=true when Node inspector breakpoints are needed.'
        : 'Debugger pause disabled; scan completed immediately.',
      scan,
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Interactive candidate debugging failed', status: 500 });
  }
}
