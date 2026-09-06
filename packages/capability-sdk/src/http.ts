/** Applies the bound while reading, rather than after buffering an arbitrary response. */
export async function readBoundedResponseText(response: Response, maxBytes = 8_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
