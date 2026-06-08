import { NextResponse } from 'next/server';
import { getBrowserChatSession, subscribeBrowserChatSessionEvents } from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let idlePingTicks = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          unsubscribe?.();
          if (keepAlive) clearInterval(keepAlive);
        }
      };

      unsubscribe = subscribeBrowserChatSessionEvents(sessionId, (event) => send('refresh', event));
      if (!unsubscribe) {
        closed = true;
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Browser chat session not found' })}\n\n`));
        controller.close();
        return;
      }

      send('refresh', { sessionId, time: new Date().toISOString() });
      keepAlive = setInterval(() => {
        const session = getBrowserChatSession(sessionId);
        if (session?.busy) {
          send('refresh', { sessionId, time: new Date().toISOString(), reason: 'busy-heartbeat' });
          return;
        }
        idlePingTicks += 1;
        if (idlePingTicks >= 15) {
          idlePingTicks = 0;
          send('ping', { time: new Date().toISOString() });
        }
      }, 1000);
      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe?.();
        if (keepAlive) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      });
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Connection': 'keep-alive',
    },
  });
}
