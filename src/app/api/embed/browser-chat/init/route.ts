import { NextRequest } from 'next/server';
import { getBrowserChatSession, listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { store } from '@/server/db/store';
import { joinWebPilotUrl } from '@/lib/webpilot-base-path';
import { selectEmbeddedBrowserChatSessionId } from '@/server/embed/browser-chat-init';
import {
  createEmbedToken,
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  normalizeSafetyMode,
  normalizeString,
  publicBaseUrl,
  requestOrigin,
  requestUserId,
} from '@/server/embed/browser-chat-embed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    store.applyRuntimeEnv();

    const userId = requestUserId(request, body);
    const requestedSessionId = normalizeString(body.sessionId);
    const initialSessionId = selectEmbeddedBrowserChatSessionId(
      listBrowserChatSessions({ userId }),
      requestedSessionId,
    );
    const session = initialSessionId ? getBrowserChatSession(initialSessionId, userId) : undefined;
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
    if (session) iframeUrl.searchParams.set('sessionId', session.id);
    if (userId) iframeUrl.searchParams.set('userId', userId);
    const targetUrl = session?.targetUrl || normalizeString(body.targetUrl);
    if (targetUrl) iframeUrl.searchParams.set('targetUrl', targetUrl);

    return embedJson({
      ok: true,
      version: 1,
      elementName: 'webpilot-browser-chat',
      entryUrl: joinWebPilotUrl(baseUrl, '/embed/webpilot.js'),
      iframeUrl: iframeUrl.toString(),
      apiBaseUrl: baseUrl,
      sessionId: session?.id,
      session: session || null,
      userId,
      token: embedAuth?.token,
      expiresAt: embedAuth?.expiresAt,
      mode: process.env.AI_BROWSER_MODE?.trim().toLowerCase() === 'dom' ? 'dom' : 'code',
      safetyMode: session?.safetyMode || normalizeSafetyMode(body.safetyMode),
      mountId: normalizeString(body.mountId) || normalizeString(body.containerId) || undefined,
    });
  } catch (error) {
    return embedErrorJson(error, 'Failed to initialize browser chat embed');
  }
}
