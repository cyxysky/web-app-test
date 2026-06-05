import { NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function isFinished(status?: string) {
  return status === 'passed' || status === 'failed' || status === 'blocked';
}

export async function GET(_request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const streamState: { closed: boolean; stopTimer?: () => void } = { closed: false };

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let previous = '';

      const close = () => {
        if (streamState.closed) return;
        streamState.closed = true;
        streamState.stopTimer?.();
        try {
          controller.close();
        } catch {
          // The client may have already closed the stream.
        }
      };

      const enqueue = (chunk: string) => {
        if (streamState.closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          close();
          return false;
        }
      };

      const send = () => {
        if (streamState.closed) return;
        const run = store.getRun(runId);
        if (!run) {
          enqueue(`event: error\ndata: ${JSON.stringify({ error: 'Run not found' })}\n\n`);
          close();
          return;
        }
        const payload = JSON.stringify(run);
        if (payload !== previous) {
          previous = payload;
          if (!enqueue(`event: run\ndata: ${payload}\n\n`)) return;
        } else {
          if (!enqueue(': heartbeat\n\n')) return;
        }
        if (isFinished(run.status) && run.report?.markdown) {
          close();
        }
      };

      send();
      if (!streamState.closed) {
        const timer = setInterval(send, 1000);
        streamState.stopTimer = () => clearInterval(timer);
      }
    },
    cancel() {
      streamState.closed = true;
      streamState.stopTimer?.();
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}
