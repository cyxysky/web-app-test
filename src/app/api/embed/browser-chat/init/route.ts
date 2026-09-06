import { NextRequest } from 'next/server';
import { z } from 'zod';
import { listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { readBrowserChatSessionPage } from '@/server/ai/agents/browser-chat-read.service';
import { store } from '@/server/db/store';
import { joinWebPilotUrl } from '@/lib/webpilot-base-path';
import { selectEmbeddedBrowserChatSessionId } from '@/server/embed/browser-chat-init';
import { createMountIdentityTicket } from '@/server/auth/mount-identity';
import {
  createEmbedToken,
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  normalizeSafetyMode,
  normalizeString,
  publicBaseUrl,
  requestOrigin,
} from '@/server/embed/browser-chat-embed';
import { parseJsonRequest } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const initSchema = z.object({
  userId: z.union([z.string(), z.number()]),
  sessionId: z.unknown().optional(),
  targetUrl: z.unknown().optional(),
  tokenTtlSeconds: z.unknown().optional(),
  safetyMode: z.unknown().optional(),
  mountId: z.unknown().optional(),
  containerId: z.unknown().optional(),
}).passthrough();

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, initSchema, { maxBytes: 64 * 1024 });
    await store.applyRuntimeEnv();

    const mountedIdentity = createMountIdentityTicket({
      origin: requestOrigin(request),
      userId: body.userId,
    });
    const userId = mountedIdentity.userId;
    const requestedSessionId = normalizeString(body.sessionId);
    const initialSessionId = selectEmbeddedBrowserChatSessionId(
      await listBrowserChatSessions({ userId }),
      requestedSessionId,
    );
    const session = initialSessionId ? await readBrowserChatSessionPage(initialSessionId, userId) : undefined;
    if (requestedSessionId && !session) throw new Error('Browser chat session not found');
    const ttlSeconds = Number.isFinite(Number(body.tokenTtlSeconds))
      ? Number(body.tokenTtlSeconds)
      : undefined;
    const embedAuth = session ? createEmbedToken({
      sessionId: session.id,
      userId,
      origin: requestOrigin(request),
      ttlSeconds,
    }) : undefined;
    const baseUrl = publicBaseUrl(request);
    const iframeUrl = new URL(joinWebPilotUrl(baseUrl, '/browser-chat'));
    iframeUrl.searchParams.set('webpilotEmbed', '1');
    iframeUrl.searchParams.set('identityTicket', mountedIdentity.ticket);
    if (session) iframeUrl.searchParams.set('sessionId', session.id);
    const targetUrl = session?.targetUrl || normalizeString(body.targetUrl);
    if (targetUrl) iframeUrl.searchParams.set('targetUrl', targetUrl);

    return embedJson({
      ok: true,
      version: 2,
      elementName: 'webpilot-browser-chat',
      entryUrl: joinWebPilotUrl(baseUrl, '/embed/orbit.js'),
      iframeUrl: iframeUrl.toString(),
      apiBaseUrl: baseUrl,
      sessionId: session?.id,
      session: session || null,
      userId,
      token: embedAuth?.token,
      expiresAt: embedAuth?.expiresAt,
      safetyMode: session?.safetyMode || normalizeSafetyMode(body.safetyMode),
      mountId: normalizeString(body.mountId) || normalizeString(body.containerId) || undefined,
    });
  } catch (error) {
    return embedErrorJson(error, 'Failed to initialize browser chat embed');
  }
}
