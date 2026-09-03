import { normalizeBrowserToolInput } from '@webpilot/capability-browser';
import { normalizeFileToolInput } from '@webpilot/capability-file';
import {
  arrayFromJsonString,
  jsonRecordFromUnknown,
  unwrapToolTransport,
} from '@webpilot/capability-sdk';

function browserCodeFromGeneratedMarkup(value: unknown) {
  if (typeof value !== 'string') return value;
  let code = value.trim();
  code = code
    .replace(/^```(?:javascript|js)?[ \t]*\r?\n/i, '')
    .replace(/\r?\n```[ \t]*$/i, '')
    .replace(/^<code(?:\s[^>]*)?>\s*/i, '')
    .replace(/\s*<\/code>$/i, '')
    .trim();
  return code;
}

/** Scalar transport normalization only; never reshape a document or program. */
export function coerceBrowserChatToolInput(toolName: string, value: unknown) {
  if (toolName === 'browser') {
    const source = jsonRecordFromUnknown(unwrapToolTransport(value));
    if (!source) return value;
    return normalizeBrowserToolInput({
      ...source,
      ...('code' in source ? { code: browserCodeFromGeneratedMarkup(source.code) } : {}),
    });
  }
  if (toolName === 'reportDefect') {
    const source = jsonRecordFromUnknown(unwrapToolTransport(value));
    if (!source) return value;
    return {
      ...source,
      reasons: arrayFromJsonString(source.reasons),
      reproductionSteps: arrayFromJsonString(source.reproductionSteps),
      screenshotFileNames: arrayFromJsonString(source.screenshotFileNames),
    };
  }
  return toolName === 'file' ? normalizeFileToolInput(value) : value;
}

export function repairBrowserChatToolCallInput(toolName: string, rawInput: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return undefined;
  }
  const repaired = coerceBrowserChatToolInput(toolName, parsed);
  const serialized = JSON.stringify(repaired);
  return serialized !== JSON.stringify(parsed) ? serialized : undefined;
}
