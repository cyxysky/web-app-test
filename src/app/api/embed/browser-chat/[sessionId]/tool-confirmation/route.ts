import { NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveBrowserChatToolConfirmation } from '@/server/ai/agents/browser-chat.service';
import {
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  readEmbedAuth,
} from '@/server/embed/browser-chat-embed';
import { parseJsonRequest } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

const confirmationSchema = z.object({
  confirmationId: z.string().trim().min(1).max(200),
  action: z.enum(['confirm', 'cancel']),
}).strict();

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const auth = readEmbedAuth(request, sessionId);
    const body = await parseJsonRequest(request, confirmationSchema, { maxBytes: 8 * 1024 });
    const session = resolveBrowserChatToolConfirmation(sessionId, body.confirmationId, body.action, auth.userId);
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to resolve tool confirmation');
  }
}
