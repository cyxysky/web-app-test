import { NextRequest } from 'next/server';
import { z } from 'zod';
import { sendBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';
import {
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  normalizeSafetyMode,
  readEmbedAuth,
} from '@/server/embed/browser-chat-embed';
import { parseJsonRequest } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

const messageSchema = z.object({
  content: z.string().max(1_000_000),
  safetyMode: z.unknown().optional(),
  modelProvider: z.string().max(200).optional(),
  model: z.string().max(500).optional(),
  clientMessageId: z.string().max(200).optional(),
  attachments: z.unknown().optional(),
  skillIds: z.unknown().optional(),
}).strict();

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const auth = readEmbedAuth(request, sessionId);
    const body = await parseJsonRequest(request, messageSchema, { maxBytes: 2 * 1024 * 1024 });
    const content = typeof body.content === 'string' ? body.content : '';
    const session = await sendBrowserChatMessage(
      sessionId,
      content,
      normalizeSafetyMode(body.safetyMode),
      typeof body.modelProvider === 'string' ? body.modelProvider : undefined,
      typeof body.model === 'string' ? body.model : undefined,
      typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined,
      body.attachments,
      body.skillIds,
      auth.userId,
    );
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to send browser chat message');
  }
}
