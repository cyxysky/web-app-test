export function parseJsonObjectText(value?: string) {
  const text = (value || '').trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function stripAnsiControlCodes(value: string) {
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export function formatToolPayload(value: unknown) {
  if (value === undefined || value === null || value === '') return 'None';
  if (typeof value === 'string') return stripAnsiControlCodes(value);
  try {
    return stripAnsiControlCodes(JSON.stringify(value, null, 2));
  } catch {
    return stripAnsiControlCodes(String(value));
  }
}

export function formatLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function phaseLabel(phase: string) {
  if (phase.startsWith('browser:')) return 'Browser';
  if (phase.startsWith('ai:')) return 'AI';
  if (phase.startsWith('chat:')) return 'Chat';
  if (phase.startsWith('perf:')) return 'Perf';
  return phase;
}
