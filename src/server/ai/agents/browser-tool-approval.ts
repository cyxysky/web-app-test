import { analyzeBrowserCodeRisk } from '@webpilot/capability-browser/node';
import { isReadOnlyStatement } from '@webpilot/capability-data';

export type BrowserToolApprovalRequest = {
  prompt: string;
  reason?: string;
};

function compact(value: unknown, max = 240) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function browserToolApprovalRequest(input: {
  toolName: string;
  toolInput: unknown;
}): BrowserToolApprovalRequest | undefined {
  const record = input.toolInput && typeof input.toolInput === 'object' && !Array.isArray(input.toolInput)
    ? input.toolInput as Record<string, unknown>
    : {};
  const reason = compact(record.reason, 300) || undefined;

  if (input.toolName === 'browser' && record.action === 'code') {
    const code = typeof record.code === 'string' ? record.code : '';
    const risk = analyzeBrowserCodeRisk(code);
    if (!risk.requiresConfirmation) return undefined;
    return {
      reason,
      prompt: reason || `请确认是否执行浏览器代码：${compact(code, 180)}`,
    };
  }

  if (input.toolName === 'file' && record.action === 'download') {
    return { reason, prompt: `请确认是否下载文件${reason ? `：${reason}` : ''}` };
  }

  const action = typeof record.action === 'string' ? record.action : '';
  const approvalRequired = (
    (input.toolName === 'codeSandbox' && action === 'run')
    || (input.toolName === 'connectors' && action === 'call')
    || (input.toolName === 'knowledge' && action === 'delete')
    || (input.toolName === 'data' && action === 'query' && !isReadOnlyStatement(typeof record.statement === 'string' ? record.statement : ''))
    || (input.toolName === 'media' && action === 'generateImage')
    || (input.toolName === 'communication' && action === 'send')
    || (input.toolName === 'git' && (action === 'applyPatch' || action === 'commit'))
    || (input.toolName === 'computer' && ['click', 'type', 'key', 'scroll'].includes(action))
    || (input.toolName === 'workflow' && action === 'cancel')
  );
  if (approvalRequired) {
    return {
      reason,
      prompt: reason || `请确认是否执行 ${input.toolName} ${action} 操作。`,
    };
  }

  return undefined;
}
