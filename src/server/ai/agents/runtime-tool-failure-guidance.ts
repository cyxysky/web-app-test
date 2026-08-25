import type { BrowserActionResult } from '@/server/browser/browser-session';
import { browserCodeRuntimeSkillId } from './browser-code-runtime-skill';

function requiredNextActionFromActual(actual: string) {
  try {
    const parsed = JSON.parse(actual) as { requiredNextAction?: unknown };
    return typeof parsed?.requiredNextAction === 'string' && parsed.requiredNextAction.trim()
      ? parsed.requiredNextAction.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function toolFailureRequiredNextAction(name: string, result: BrowserActionResult) {
  if (result.requiredNextAction?.trim()) return result.requiredNextAction.trim();
  const fromActual = requiredNextActionFromActual(result.actual);
  if (fromActual) return fromActual;
  const surfaceId = result.actual.match(/(?:coveredBySurfaceId|activeSurfaceId|surfaceId)[=:"\s]+([\w.-]+)/i)?.[1];
  if (name === 'browserCode' && /ACTIONABILITY_FAILED|covered by|viewport-blocking|surface/i.test(result.actual)) {
    return `执行一个独立的只读 browserCode：读取 await page.activeSurface() 和目标区域的 page.domSnapshot()/Playwright 状态，${surfaceId ? `找到 surface id=${surfaceId}，` : ''}确认遮挡浮层的类型与关闭条件；等待加载层消失或通过已观察到的控件关闭浮层后，再使用原 locator 重试。`;
  }
  if (name === 'browserCode') {
    return '保留本次 code、失败 locator 和完整错误；执行一个独立的只读 browserCode 刷新 tabs、URL、title、page.activeSurface() 与目标 DOM 证据，依据新证据修正代码后再重试。';
  }
  if (name === 'readBrowserState') {
    return '检查浏览器会话是否已经启动且仍可用，然后重新调用 readBrowserState；在成功读取当前标签页和页面状态前不要执行浏览器操作。';
  }
  if (name === 'skill') {
    return `使用系统提示中给出的精确 Skill id 重试 skill action=read；执行 browserCode 前必须先成功读取 ${browserCodeRuntimeSkillId}。`;
  }
  if (name === 'file' || name === 'fileVisual') {
    return '读取完整错误和当前文档工作流状态，按返回的 documentId、revision、digest 与要求的下一动作修正参数后重试；不要重新创建替代文档。';
  }
  if (name === 'subagent') {
    return '读取完整错误；若是参数问题，按要求修正 action/tasks/uuid，若已有待读取 UUID，则先按返回顺序读取该子 Agent 结果。';
  }
  return `读取 ${name} 的完整错误、参数路径和当前状态，执行只读检查确认失败原因，修正输入或前置状态后再重试；不要原样重复失败调用。`;
}

function appendRequiredNextAction(actual: string, requiredNextAction: string) {
  try {
    const parsed = JSON.parse(actual) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.requiredNextAction !== 'string' || !record.requiredNextAction.trim()) {
        record.requiredNextAction = requiredNextAction;
      }
      return JSON.stringify(record, null, 2);
    }
  } catch {
    // Plain-text tool results receive the same guidance below.
  }
  if (/Required next action:/i.test(actual)) return actual;
  return `${actual}\nRequired next action: ${requiredNextAction}`;
}

export function withToolFailureGuidance(name: string, result: BrowserActionResult): BrowserActionResult {
  if (result.ok) return result;
  const requiredNextAction = toolFailureRequiredNextAction(name, result);
  return {
    ...result,
    actual: appendRequiredNextAction(result.actual, requiredNextAction),
    requiredNextAction,
  };
}
