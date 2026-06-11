import type { AiRequestSnapshot, StepToolCall } from '@/server/ai/schemas/test-case.schema';

export function aiRequestText(request?: AiRequestSnapshot) {
  if (!request?.messages?.length) return '';
  return request.messages
    .flatMap((message) => message.content || [])
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n\n');
}

function sectionAfter(text: string, label: string) {
  const index = text.indexOf(label);
  if (index < 0) return '';
  return text.slice(index + label.length);
}

export function extractDomTreeFromAiRequest(request?: AiRequestSnapshot) {
  if (request?.domContext?.tree) return request.domContext.tree;
  const text = aiRequestText(request);
  const section = sectionAfter(text, 'Simplified DOM tree:\n');
  if (!section) return '';

  const endMarkers = [
    '\nRunState JSON',
    '\nAvailable previous screenshot references:',
    '\nSelected reference screenshots:',
    '\nScreenshot image',
    '\nAgent Loop / prepareStep context:',
  ];
  const endIndex = endMarkers
    .map((marker) => section.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return (endIndex === undefined ? section : section.slice(0, endIndex)).trim();
}

export function domTreeFromToolCall(tool?: StepToolCall, request?: AiRequestSnapshot) {
  return (
    tool?.contextBefore?.domContext?.tree ||
    tool?.contextAfter?.domContext?.tree ||
    extractDomTreeFromAiRequest(request)
  );
}
