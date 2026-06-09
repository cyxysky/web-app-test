import { currentRunSnapshotEvent, store, subscribeRunUpdates } from '@/server/db/mock-store';
import { createSnapshotEventStream } from '@/server/realtime/snapshot-channel';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function isFinished(status?: string) {
  return status === 'passed' || status === 'failed' || status === 'blocked';
}

export async function GET(request: Request, context: RouteContext) {
  const { runId } = await context.params;
  return createSnapshotEventStream({
    request,
    eventName: 'run',
    getSnapshot: () => store.getRun(runId),
    initialEvent: (run) => currentRunSnapshotEvent(runId, run),
    subscribe: (listener) => subscribeRunUpdates(runId, listener),
    notFoundMessage: 'Run not found',
    isComplete: (run) => isFinished(run.status) && Boolean(run.report?.markdown),
    headers: {
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
