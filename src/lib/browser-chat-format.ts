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

const payloadLineFeedToken = '\uE000webpilot-payload-lf\uE001';
const payloadTabToken = '\uE000webpilot-payload-tab\uE001';

function normalizeEmbeddedJson(value: unknown, depth = 0): unknown {
  if (depth >= 8) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) return value;
    try {
      return normalizeEmbeddedJson(JSON.parse(text), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => normalizeEmbeddedJson(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeEmbeddedJson(item, depth + 1)]));
}

function stringifyPayloadForDisplay(value: unknown) {
  const normalized = normalizeEmbeddedJson(value);
  const serialized = JSON.stringify(normalized, (_key, item) => (
    typeof item === 'string'
      ? item
        .replace(/\r\n|\r|\n/g, payloadLineFeedToken)
        .replace(/\t/g, payloadTabToken)
      : item
  ), 2);
  return serialized
    .replaceAll(payloadLineFeedToken, '\n')
    .replaceAll(payloadTabToken, '\t');
}

export function formatToolPayload(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') {
    const normalized = normalizeEmbeddedJson(value);
    if (normalized === value) return stripAnsiControlCodes(value);
    try {
      return stripAnsiControlCodes(stringifyPayloadForDisplay(normalized));
    } catch {
      return stripAnsiControlCodes(value);
    }
  }
  try {
    return stripAnsiControlCodes(stringifyPayloadForDisplay(value));
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
  if (phase.startsWith('browser:')) return '浏览器';
  if (phase.startsWith('ai:')) return 'AI';
  if (phase.startsWith('chat:')) return '对话';
  if (phase.startsWith('target:')) return '目标';
  if (phase.startsWith('perf:')) return '性能';
  return phase;
}
