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

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let previous = '';
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        controller.close();
      };

      const send = () => {
        if (closed) return;
        const run = store.getRun(runId);
        if (!run) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Run not found' })}\n\n`));
          close();
          return;
        }
        const payload = JSON.stringify(run);
        if (payload !== previous) {
          previous = payload;
          controller.enqueue(encoder.encode(`event: run\ndata: ${payload}\n\n`));
        } else {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }
        if (isFinished(run.status) && run.report?.markdown) {
          close();
        }
      };

      send();
      timer = setInterval(send, 1000);
    },
    cancel() {},
  });

  return new NextResponse(stream, {
    headers: {
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}
