export type BrowserChatToolRequirement = 'action' | 'inspection';

const chineseActionPattern = /(?:打开|访问|进入|前往|跳转|导航到|刷新|重载|点击|双击|右键|滚动|滑动|下拉|上拉|拖拽|拖动|悬停|输入|填写|键入|按下|选择|勾选|提交|保存|删除|上传|下载|播放|暂停|关闭|切换|返回|后退|前进|登录|退出|执行|重试|向下|向上|往下|往上|下一页|上一页)/;
const englishActionPattern = /\b(?:open|visit|navigate|refresh|reload|click|double[- ]?click|right[- ]?click|scroll|swipe|drag|hover|type|fill|press|select|check|submit|save|delete|upload|download|play|pause|close|switch|go back|go forward|log in|sign in|log out|retry)\b/i;
const chineseInspectionPattern = /(?:截图|截屏|查看|检查|验证|读取|识别|观察|找出|查找|确认页面|看看页面|当前页面)/;
const englishInspectionPattern = /\b(?:screenshot|inspect|check|verify|read|observe|find|look at|current page)\b/i;
const explanatoryQuestionPattern = /(?:为什么|为何|什么是|解释|说明|介绍|教程|原理|区别|how\s+(?:do|does|can|to)|why|what\s+is|explain|describe)/i;
const explicitActionRequestPattern = /(?:帮我|替我|给我|麻烦|需要你|我要你|请你|现在|立即|马上|继续|再|重新|！|!|please|go ahead|do it|again|continue)/i;

export function browserChatToolRequirement(instruction: string): BrowserChatToolRequirement | undefined {
  const text = instruction.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (explanatoryQuestionPattern.test(text) && !explicitActionRequestPattern.test(text)) return undefined;
  if (chineseActionPattern.test(text) || englishActionPattern.test(text)) return 'action';
  if (chineseInspectionPattern.test(text) || englishInspectionPattern.test(text)) return 'inspection';
  return undefined;
}

export function browserChatReplyClaimsBrowserAction(reply: string) {
  const text = reply.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const completionClaim = /(?:已(?:经)?|成功|完成|搞定|继续下移|到达|done|completed|successfully|finished)/i.test(text);
  return completionClaim && (chineseActionPattern.test(text) || englishActionPattern.test(text));
}
