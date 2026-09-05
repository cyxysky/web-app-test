/** Application-owned context metadata is never user-facing narration. */
export const browserChatInterruptedTurnContextMarker =
  '[Historical context only: the preceding browser-chat turn was interrupted before completion. Preserve completed tool results, but never quote or copy this marker into a response.]';

const contextMarkers = [
  browserChatInterruptedTurnContextMarker,
  '[This response was interrupted by the user before completion.]',
  '[The user interrupted this turn before the assistant produced text. Any completed tool messages remain valid conversation history.]',
];

export function stripBrowserChatContextMarkers(value: string) {
  let text = value;
  for (const marker of contextMarkers) {
    text = text.replaceAll(marker, '');
    // Buffer an unfinished marker during streaming, rather than flash it and
    // remove it only after the final closing bracket arrives.
    const start = text.lastIndexOf(marker.slice(0, 24));
    if (start >= 0 && marker.startsWith(text.slice(start))) text = text.slice(0, start);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
