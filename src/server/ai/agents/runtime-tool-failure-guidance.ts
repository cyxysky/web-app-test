import type { BrowserActionResult } from '@webpilot/capability-browser/node';

export type RuntimeToolFailureCategory =
  | 'actionability'
  | 'browser-unavailable'
  | 'execution-context'
  | 'invalid-input'
  | 'javascript'
  | 'network'
  | 'policy'
  | 'reported-failure'
  | 'screenshot-timeout'
  | 'serialization'
  | 'skill-gate'
  | 'state-conflict'
  | 'subagent-workflow'
  | 'timeout'
  | 'verification'
  | 'unknown';

function parseActualObject(actual: string) {
  try {
    const parsed = JSON.parse(actual) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function classifyRuntimeToolFailure(
  name: string,
  result: Pick<BrowserActionResult, 'actual'>,
): RuntimeToolFailureCategory {
  const actual = result.actual || '';
  if (name === 'skill' || /requiredSkillId|hidden built-in Skill|runtime Skill .* not loaded/i.test(actual)) {
    return 'skill-gate';
  }
  if (name === 'subagent') return 'subagent-workflow';
  if (/browser session has not started|browser unavailable|page has been closed|target page, context or browser has been closed/i.test(actual)) {
    return 'browser-unavailable';
  }
  if (/ACTIONABILITY_FAILED|coveredBySurfaceId|activeSurfaceId|covered by|viewport-blocking|strict mode violation|(?:resolved to|matched) \d+ (?:rendered )?elements|element is not visible|element is outside|zero (?:matches|actionable)|no actionable/i.test(actual)) {
    return 'actionability';
  }
  if (/(?:page\.)?screenshot[^\n]*(?:timed out|timeout)|TimeoutError[^\n]*screenshot|waiting for fonts[^\n]*(?:timed out|timeout)/i.test(actual)) {
    return 'screenshot-timeout';
  }
  if (/execution context was destroyed|cannot find context with specified id|most likely because of a navigation|frame was detached|target closed during navigation/i.test(actual)) {
    return 'execution-context';
  }
  if (/BUSINESS_STATE_VERIFICATION_FAILED|verification[^\n]*failed|expected business-state/i.test(actual)) {
    return 'verification';
  }
  if (/forbids|policy violation|direct file paths|scripted DOM|dispatchEvent\("click"\)|DOM element\.click/i.test(actual)) {
    return 'policy';
  }
  if (/circular|serialize|serialization|JSON-safe|cannot stringify|output.*truncat|heap limit|rss limit|object graph/i.test(actual)) {
    return 'serialization';
  }
  if (/dependencyFailures|HTTP (?:408|429|5\d\d)|net::ERR_|request failed|ECONN|ENOTFOUND/i.test(actual)) {
    return 'network';
  }
  if (/browserCode returned a top-level \{ ok: false \}|"result"\s*:\s*\{\s*"ok"\s*:\s*false/i.test(actual)) {
    return 'reported-failure';
  }
  if (/agent\.state revision conflict/i.test(actual)) return 'state-conflict';
  if (/contains unsupported fields?|has unsupported field|Allowed fields:|must be (?:an? )?(?:non-empty )?(?:string|object|array|number|boolean)|must be \d+-\d+ printable characters|requires (?:a|an) |received invalid .* format|Unsupported agent\.state action/i.test(actual)) {
    return 'invalid-input';
  }
  if (/timed out|timeout|TimeoutError/i.test(actual)) return 'timeout';
  if (/ReferenceError|TypeError|SyntaxError|EvalError|RangeError|is not a function|is not defined/i.test(actual)) {
    return 'javascript';
  }
  return 'unknown';
}

function appendFailureCategory(actual: string, category: RuntimeToolFailureCategory) {
  const parsed = parseActualObject(actual);
  if (parsed) {
    if (typeof parsed.failureCategory !== 'string' || !parsed.failureCategory.trim()) {
      parsed.failureCategory = category;
    }
    return JSON.stringify(parsed, null, 2);
  }
  const metadata = /Failure category:/i.test(actual) ? '' : `Failure category: ${category}`;
  return metadata ? `${actual}\n${metadata}` : actual;
}

export function withToolFailureGuidance(name: string, result: BrowserActionResult): BrowserActionResult {
  if (result.ok) return result;
  const failureCategory = classifyRuntimeToolFailure(name, result);
  return {
    ...result,
    actual: appendFailureCategory(result.actual, failureCategory),
    failureCategory,
  };
}
