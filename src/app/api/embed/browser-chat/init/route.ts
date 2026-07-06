import { NextRequest } from 'next/server';
import { createBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { startScheduler } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/mock-store';
import {
  createEmbedToken,
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  normalizeMode,
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
    startScheduler();

    const userId = requestUserId(request, body);
    const session = createBrowserChatSession({
      targetUrl: normalizeString(body.targetUrl),
      mode: 'dom',
      safetyMode: normalizeSafetyMode(body.safetyMode),
      modelProvider: typeof body.modelProvider === 'string' ? body.modelProvider : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      title: normalizeString(body.title) || undefined,
      userId,
    });
    const ttlSeconds = Number.isFinite(Number(body.tokenTtlSeconds))
      ? Number(body.tokenTtlSeconds)
      : undefined;
    const { token, expiresAt } = createEmbedToken({
      sessionId: session.id,
      userId,
      origin: requestOrigin(request),
      ttlSeconds,
    });
    const baseUrl = publicBaseUrl(request);
    const iframeUrl = new URL('/browser-chat', baseUrl);
    iframeUrl.searchParams.set('webpilotEmbed', '1');
    iframeUrl.searchParams.set('sessionId', session.id);
    if (userId) iframeUrl.searchParams.set('userId', userId);
    if (session.targetUrl) iframeUrl.searchParams.set('targetUrl', session.targetUrl);

    return embedJson({
      ok: true,
      version: 1,
      elementName: 'webpilot-browser-chat',
      entryUrl: `${baseUrl}/embed/webpilot.js`,
      iframeUrl: iframeUrl.toString(),
      apiBaseUrl: baseUrl,
      sessionId: session.id,
      session,
      token,
      expiresAt,
      mode: session.mode,
      safetyMode: session.safetyMode,
      mountId: normalizeString(body.mountId) || normalizeString(body.containerId) || undefined,
    });
  } catch (error) {
    return embedErrorJson(error, 'Failed to initialize browser chat embed');
  }
}
