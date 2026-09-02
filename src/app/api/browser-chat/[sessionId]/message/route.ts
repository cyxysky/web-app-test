import { NextRequest } from 'next/server';
import { createUIMessageStream, createUIMessageStreamResponse, type DynamicToolUIPart } from 'ai';
import {
  interruptBrowserChatSession,
  sendBrowserChatMessage,
  subscribeBrowserChatUIStream,
} from '@/server/ai/agents/browser-chat.service';
import type { BrowserChatUIMessage } from '@/lib/browser-chat-ui-message';
import { sendBrowserChatMessageRequestSchema } from '@/server/http/browser-chat-request.schema';
import { ApiRequestError, apiError, parseJsonRequest } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await parseJsonRequest(request, sendBrowserChatMessageRequestSchema, { maxBytes: 512 * 1024 });
    const userId = requestUserId(request);
    const clientMessageId = body.clientMessageId?.trim();
    if (!clientMessageId) {
      throw new ApiRequestError('clientMessageId is required for UI message streaming', {
        code: 'invalid_request',
        status: 400,
      });
    }
    const stream = createUIMessageStream<BrowserChatUIMessage>({
      execute: async ({ writer }) => {
        let started = false;
        let finished = false;
        const textValues = new Map<string, string>();
        const toolInputs = new Set<string>();
        const toolOutputs = new Map<string, string>();
        const dataParts = new Map<string, string>();
        let messageMetadataSignature = '';
        let resolveTerminal: () => void = () => undefined;
        const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
        const unsubscribe = subscribeBrowserChatUIStream(sessionId, clientMessageId, ({ message }) => {
          if (!message || finished) return;
          const messageMetadata = {
            sessionId,
            clientMessageId,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            status: message.status,
          };
          const nextMetadataSignature = JSON.stringify(messageMetadata);
          if (!started) {
            started = true;
            messageMetadataSignature = nextMetadataSignature;
            writer.write({
              type: 'start',
              messageId: message.id,
              messageMetadata,
            });
          } else if (messageMetadataSignature !== nextMetadataSignature) {
            messageMetadataSignature = nextMetadataSignature;
            writer.write({
              type: 'message-metadata',
              messageMetadata,
            });
          }

          let textIndex = 0;
          for (const part of message.parts || []) {
            if (part.type === 'text') {
              const textId = `text-${textIndex++}`;
              const previousText = textValues.get(textId);
              if (previousText === undefined) {
                writer.write({ type: 'text-start', id: textId });
                if (part.text) writer.write({ type: 'text-delta', id: textId, delta: part.text });
                textValues.set(textId, part.text);
              } else if (part.text.length > previousText.length && part.text.startsWith(previousText)) {
                writer.write({ type: 'text-delta', id: textId, delta: part.text.slice(previousText.length) });
                textValues.set(textId, part.text);
              }
              continue;
            }
            if (part.type === 'dynamic-tool') {
              const tool = part as DynamicToolUIPart;
              if (!toolInputs.has(tool.toolCallId)) {
                toolInputs.add(tool.toolCallId);
                writer.write({
                  type: 'tool-input-available',
                  toolCallId: tool.toolCallId,
                  toolName: tool.toolName,
                  input: tool.input,
                  dynamic: true,
                });
              }
              if (tool.state === 'output-available') {
                const signature = JSON.stringify(tool.output);
                if (toolOutputs.get(tool.toolCallId) !== signature) {
                  toolOutputs.set(tool.toolCallId, signature);
                  writer.write({
                    type: 'tool-output-available',
                    toolCallId: tool.toolCallId,
                    output: tool.output,
                    dynamic: true,
                  });
                }
              } else if (tool.state === 'output-error') {
                const signature = `error:${tool.errorText}`;
                if (toolOutputs.get(tool.toolCallId) !== signature) {
                  toolOutputs.set(tool.toolCallId, signature);
                  writer.write({
                    type: 'tool-output-error',
                    toolCallId: tool.toolCallId,
                    errorText: tool.errorText,
                    dynamic: true,
                  });
                }
              }
              continue;
            }
            if (part.type === 'data-chart' || part.type === 'data-ui' || part.type === 'data-step' || part.type === 'data-activity') {
              const key = `${part.type}:${part.id || ''}`;
              const signature = JSON.stringify(part.data);
              if (dataParts.get(key) === signature) continue;
              dataParts.set(key, signature);
              writer.write(part);
            }
          }

          if (message.activity) {
            const key = 'data-activity:current';
            const signature = JSON.stringify(message.activity);
            if (dataParts.get(key) !== signature) {
              dataParts.set(key, signature);
              writer.write({ type: 'data-activity', id: 'current', data: message.activity });
            }
          }

          if (message.status && message.status !== 'running' && message.status !== 'queued') {
            finished = true;
            for (const textId of textValues.keys()) writer.write({ type: 'text-end', id: textId });
            writer.write({
              type: 'finish',
              finishReason: 'stop',
              messageMetadata,
            });
            resolveTerminal();
          }
        });
        const abort = () => {
          if (!finished) void interruptBrowserChatSession(sessionId, clientMessageId, userId);
          resolveTerminal();
        };
        request.signal.addEventListener('abort', abort, { once: true });
        try {
          await sendBrowserChatMessage(
            sessionId,
            body.content,
            body.safetyMode,
            body.modelProvider,
            body.model,
            clientMessageId,
            body.attachments,
            body.skillIds,
            userId,
          );
          await terminal;
        } finally {
          request.signal.removeEventListener('abort', abort);
          unsubscribe();
        }
      },
      onError: (error) => error instanceof Error ? error.message : 'Failed to stream browser chat message',
    });
    return createUIMessageStreamResponse({
      stream,
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send browser chat message';
    const normalizedError = /Browser chat session not found/i.test(message)
      ? new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 })
      : error;
    return apiError(request, normalizedError, { fallback: 'Failed to send browser chat message' });
  }
}
