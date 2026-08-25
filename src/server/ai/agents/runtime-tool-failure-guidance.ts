import type { BrowserActionResult } from '@/server/browser/browser-session';
import { resolveBrowserCodeRuntimeMode } from '@/server/browser/browser-code-runtime-mode';

export type RuntimeToolFailureCategory =
  | 'actionability'
  | 'browser-unavailable'
  | 'execution-context'
  | 'file-workflow'
  | 'javascript'
  | 'network'
  | 'policy'
  | 'reported-failure'
  | 'screenshot-timeout'
  | 'serialization'
  | 'skill-gate'
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

function requiredNextActionFromActual(actual: string) {
  const parsed = parseActualObject(actual);
  return typeof parsed?.requiredNextAction === 'string' && parsed.requiredNextAction.trim()
    ? parsed.requiredNextAction.trim()
    : undefined;
}

export function classifyRuntimeToolFailure(
  name: string,
  result: Pick<BrowserActionResult, 'actual'>,
): RuntimeToolFailureCategory {
  const actual = result.actual || '';
  if (name === 'skill' || /requiredSkillId|hidden built-in Skill|runtime Skill .* not loaded/i.test(actual)) {
    return 'skill-gate';
  }
  if (name === 'file' || name === 'fileVisual') return 'file-workflow';
  if (name === 'subagent') return 'subagent-workflow';
  if (name === 'readBrowserState' || /browser session has not started|browser unavailable|page has been closed|target page, context or browser has been closed/i.test(actual)) {
    return 'browser-unavailable';
  }
  if (/ACTIONABILITY_FAILED|coveredBySurfaceId|activeSurfaceId|covered by|viewport-blocking|strict mode violation|resolved to \d+ elements|element is not visible|element is outside|zero (?:matches|actionable)|no actionable/i.test(actual)) {
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
  if (/timed out|timeout|TimeoutError/i.test(actual)) return 'timeout';
  if (/ReferenceError|TypeError|SyntaxError|EvalError|RangeError|is not a function|is not defined/i.test(actual)) {
    return 'javascript';
  }
  return 'unknown';
}

function toolFailureRequiredNextAction(
  name: string,
  result: BrowserActionResult,
  category: RuntimeToolFailureCategory,
) {
  if (result.requiredNextAction?.trim()) return result.requiredNextAction.trim();
  const fromActual = requiredNextActionFromActual(result.actual);
  if (fromActual) return fromActual;
  const surfaceId = result.actual.match(/(?:coveredBySurfaceId|activeSurfaceId|surfaceId)[=:"\s]+([\w.-]+)/i)?.[1];
  const restrictedBrowserApi = resolveBrowserCodeRuntimeMode() === 'restricted';

  switch (category) {
    case 'skill-gate':
      return '使用失败结果中的 requiredSkillId（或系统提示列出的精确隐藏 Skill id）执行一次 skill action=read；读取成功后的下一模型步再原样重试被拦截的工具。';
    case 'browser-unavailable':
      return '确认当前浏览器会话仍可启动且页面未关闭，然后只重试一次 readBrowserState；若会话仍不可用，停止浏览器工具并报告会话不可用。';
    case 'actionability':
      return restrictedBrowserApi
        ? `保留失败 LocatorTarget；执行一个独立只读 browserCode，通过 browserApi.surface() 和 browserApi.snapshot/read/inspect 获取目标区域最新状态，${surfaceId ? `检查 surface id=${surfaceId}，` : ''}根据新证据缩小到唯一可操作目标后只重试一次。不要盲目滚动、force 或重复原目标。`
        : `保留失败 locator；执行一个独立只读 browserCode，读取 await page.activeSurface() 和目标区域的最新 DOM/Playwright 状态，${surfaceId ? `检查 surface id=${surfaceId}，` : ''}根据新证据关闭或等待实际遮挡层、缩小到唯一可操作目标后只重试一次。不要盲目滚动、force 或重复原 locator。`;
    case 'screenshot-timeout':
      return restrictedBrowserApi
        ? '本轮不要继续尝试不同截图参数或更长截图超时；改用 browserApi.snapshot/read/inspect 和 browserApi.surface() 完成判断。只有像素证据不可替代时才报告截图受阻。'
        : '本轮不要继续尝试不同截图参数或更长截图超时；改用 page.domSnapshot()、locator 文本/值/属性和 page.activeSurface() 完成判断。只有像素证据不可替代时才报告截图受阻。';
    case 'execution-context':
      return '页面在读取期间发生导航或 frame 替换。等待一次明确的 URL/load state，重新获取 Page/Frame/Locator 后做一个针对性读取；如果页面仍在持续重载，改用最新稳定页面证据或报告该限制。';
    case 'verification':
      return '不要重复刚才的写操作。读取最新 URL、目标字段/业务状态和 activeSurface，判断操作未生效还是验证条件写错；只执行能改变该差异的下一步。';
    case 'policy':
      return restrictedBrowserApi
        ? '删除未记录的运行时对象或绕过实现，只使用 Skill 中记录的 browserApi；元素动作使用唯一 LocatorTarget，上传/凭据使用 browserApi.act 的受信动作，坐标必须来自已查看截图或 exact target 的当前 rect。'
        : '删除绕过运行时安全边界的实现，改用唯一可见 Playwright Locator、attachmentVault、credentialVault、上一模型步截图支持的 CUA API，或 exact Locator.boundingBox() 返回的 rect 内坐标；不要猜测坐标或换一种脚本方式重复同一绕过。';
    case 'serialization':
      return '将输出缩小为字符串、数字、布尔值和小型普通对象；从复杂 Page/Locator/Response/DOM 对象中显式提取需要的字段后再 nodeRepl.write，不要遍历私有属性或大型对象图。';
    case 'network':
      return '先读取 dependencyFailures 中的请求 URL、状态码和失败类型；仅在错误可重试且业务状态未改变时重试一次相关页面动作，否则报告上游网络限制。';
    case 'reported-failure':
      return '这是 cell 自己报告的失败。不要把异常捕获后写成 { ok: false }；保留原错误并让失败操作直接 throw，或修正失败原因后执行一次有明确后置条件的调用。';
    case 'timeout':
      return '确认等待的具体 URL、元素或状态是否仍可能出现；用一次更具体的状态等待或目标读取替代原超时调用。若目标状态不存在，不要只增加 timeout 或原样重试。';
    case 'javascript':
      return '依据完整错误修正报错的变量、方法或返回值形状，并用一个小型只读 cell 验证该 API 形状；不要探测私有框架对象，也不要连续尝试同义属性名。';
    case 'file-workflow':
      return '读取完整错误和当前文档工作流状态，按返回的 documentId、revision、digest 与要求的下一动作修正参数后重试；不要重新创建替代文档。';
    case 'subagent-workflow':
      return '读取完整错误；参数错误时修正 action/tasks/uuid，已有待读取 UUID 时按返回顺序逐个读取；不要原样重复被拒绝的参数形状。';
    default:
      return name === 'browserCode'
        ? '保留失败 code、locator 和完整错误；做一个最小只读检查以确认失败前提，只在获得能改变实现的新证据后重试一次。若没有新的可操作证据，报告当前限制。'
        : `读取 ${name} 的完整错误、参数路径和当前状态，执行最小只读检查确认原因，修正输入或前置状态后只重试一次；不要原样重复失败调用。`;
  }
}

function appendFailureMetadata(
  actual: string,
  category: RuntimeToolFailureCategory,
  requiredNextAction: string,
) {
  const parsed = parseActualObject(actual);
  if (parsed) {
    if (typeof parsed.failureCategory !== 'string' || !parsed.failureCategory.trim()) {
      parsed.failureCategory = category;
    }
    if (typeof parsed.requiredNextAction !== 'string' || !parsed.requiredNextAction.trim()) {
      parsed.requiredNextAction = requiredNextAction;
    }
    return JSON.stringify(parsed, null, 2);
  }
  const metadata = [
    /Failure category:/i.test(actual) ? '' : `Failure category: ${category}`,
    /Required next action:/i.test(actual) ? '' : `Required next action: ${requiredNextAction}`,
  ].filter(Boolean).join('\n');
  return metadata ? `${actual}\n${metadata}` : actual;
}

export function withToolFailureGuidance(name: string, result: BrowserActionResult): BrowserActionResult {
  if (result.ok) return result;
  const failureCategory = classifyRuntimeToolFailure(name, result);
  const requiredNextAction = toolFailureRequiredNextAction(name, result, failureCategory);
  return {
    ...result,
    actual: appendFailureMetadata(result.actual, failureCategory, requiredNextAction),
    failureCategory,
    requiredNextAction,
  };
}
