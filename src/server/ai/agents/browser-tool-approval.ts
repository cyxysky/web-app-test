import { analyzeBrowserCodeRisk } from '@/server/browser/browser-code-runner';

export type BrowserToolApprovalRequest = {
  prompt: string;
  reason?: string;
};

const committingIntent = /(?:\b(?:submit|confirm|save|delete|remove|destroy|clear|publish|send|approve|reject|authorize|pay|purchase|checkout|order|transfer|share|invite|export|download|sign\s*(?:in|out|up)|log\s*(?:in|out)|create\s+(?:account|user)|upload)\b|提交|确认|保存|删除|移除|清空|发布|发送|批准|拒绝|授权|付款|支付|购买|下单|转账|分享|邀请|登录|登出|注册|创建账号|上传|导出|下载)/i;
const committingKeys = /^(?:Enter|NumpadEnter|Delete|Backspace|Control\+S|Meta\+S)$/i;

function compact(value: unknown, max = 240) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function browserToolApprovalRequest(input: {
  toolName: string;
  toolInput: unknown;
  targetDescription?: string;
}): BrowserToolApprovalRequest | undefined {
  const record = input.toolInput && typeof input.toolInput === 'object' && !Array.isArray(input.toolInput)
    ? input.toolInput as Record<string, unknown>
    : {};
  const reason = compact(record.reason, 300) || undefined;

  if (input.toolName === 'browserCode') {
    const code = typeof record.code === 'string' ? record.code : '';
    const risk = analyzeBrowserCodeRisk(code);
    if (!risk.requiresConfirmation) return undefined;
    return {
      reason,
      prompt: reason || `请确认是否执行浏览器代码：${compact(code, 180)}`,
    };
  }

  if (input.toolName === 'downloadFile') {
    return { reason, prompt: `请确认是否下载文件${reason ? `：${reason}` : ''}` };
  }

  if (input.toolName !== 'interact') return undefined;
  const action = compact(record.action, 40);
  if (!['click', 'press', 'shortcut', 'drag'].includes(action)) return undefined;

  const keys = Array.isArray(record.keys) ? record.keys.map((key) => compact(key, 40)).filter(Boolean) : [];
  const key = compact(record.key, 40);
  const context = [
    input.targetDescription,
    reason,
    compact(record.label),
    compact(record.value),
    key,
    keys.join('+'),
  ].filter(Boolean).join(' ');
  const keyCommits = (key && committingKeys.test(key)) || keys.some((item) => committingKeys.test(item));
  const followByEnter = record.followByEnter === true;
  if (!committingIntent.test(context) && !keyCommits && !followByEnter) return undefined;

  const operation = compact(input.targetDescription, 180) || reason || `${action} 操作`;
  return {
    reason,
    prompt: `请确认是否执行可能产生外部影响的操作：${operation}`,
  };
}
