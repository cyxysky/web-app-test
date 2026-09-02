import type { CapabilityResult } from '@webpilot/capability-sdk';
import type { BrowserActionResult } from '@webpilot/capability-browser/node';

type BrowserActionResultEnvelope = {
  runtime: 'webpilot.browser-action-result' | 'webpilot.browser-operation';
  result: BrowserActionResult;
};

function browserActionEnvelope(value: unknown): BrowserActionResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Partial<BrowserActionResultEnvelope>;
  return envelope.runtime === 'webpilot.browser-action-result' || envelope.runtime === 'webpilot.browser-operation'
    ? envelope.result
    : undefined;
}

export function browserActionResultToCapabilityResult(
  result: BrowserActionResult,
): CapabilityResult<BrowserActionResultEnvelope> {
  const envelope: BrowserActionResultEnvelope = {
    runtime: 'webpilot.browser-action-result',
    result,
  };
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.failureCategory || 'browser-action-failed',
        message: result.actual,
        details: envelope,
      },
    };
  }
  return {
    ok: true,
    summary: result.actual,
    data: envelope,
  };
}

export function capabilityResultToBrowserActionResult(
  result: CapabilityResult,
): BrowserActionResult {
  if (!result.ok) {
    return browserActionEnvelope(result.error.details) || {
      ok: false,
      actual: result.error.message,
      failureCategory: result.error.code,
    };
  }
  const browserResult = browserActionEnvelope(result.data);
  if (browserResult) return browserResult;
  return {
    ok: true,
    actual: JSON.stringify({
      ok: true,
      summary: result.summary,
      ...(result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : result.data === undefined ? {} : { data: result.data }),
      ...(result.content?.length ? { content: result.content } : {}),
    }, null, 2),
  };
}
