import path from 'node:path';
import type { StepExecutionResult, TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

// 将运行状态转换成报告里展示的中文文案。
function statusText(status: TestRunRecord['status'] | StepExecutionResult['status']) {
  if (status === 'passed') return '通过';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '阻塞';
  if (status === 'running') return '运行中';
  return '排队中';
}

// 把本地 artifacts 文件路径转换成受保护的 API 访问路径。
function artifactUrl(filePath?: string) {
  if (!filePath) return undefined;
  const root = path.resolve(process.cwd(), 'artifacts');
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  if (relative.startsWith('..')) return undefined;
  return `/api/artifacts/${relative}`;
}

// 格式化工具参数，保证报告中可以直接看到 AI 调用浏览器工具时传了什么。
function formatToolInput(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// 生成单个步骤的工具调用 markdown 片段。
function toolMarkdown(step: StepExecutionResult) {
  if (!step.tools?.length) return '- 工具调用：无';
  return [
    '- 工具调用：',
    ...step.tools.map((tool) => {
      const input = formatToolInput(tool.input);
      return `  - ${tool.name}${input ? ` ${input}` : ''}${tool.reason ? `\n    - 调用原因：${tool.reason}` : ''}`;
    }),
  ].join('\n');
}

// 生成单个执行步骤的 markdown，包含执行前后截图和工具调用。
function stepMarkdown(step: StepExecutionResult) {
  const before = artifactUrl(step.beforeScreenshotPath);
  const after = artifactUrl(step.afterScreenshotPath || step.screenshotPath);

  return `### 步骤 ${step.index}

- AI 操作：${step.action}
${toolMarkdown(step)}
${step.observation ? `\n- 助手观察：${step.observation}` : ''}
${step.findings?.length ? `\n- 重要发现：\n${step.findings.map((item) => `  - ${item}`).join('\n')}` : ''}
${before ? `\n![步骤 ${step.index} 执行前](${before})` : ''}
${after ? `\n![步骤 ${step.index} 执行后](${after})` : ''}`;
}

// 汇总测试用例、运行结果和步骤证据，生成最终测试报告对象。
export function writeReport(testCase: TestCaseRecord, run: TestRunRecord) {
  const result = run.result;
  const status = run.status;
  const stepBlocks = (result?.steps || []).map(stepMarkdown).join('\n\n');
  const memory = result?.memory;

  const summary =
    status === 'passed'
      ? '所有可执行步骤均已完成，未发现阻塞性问题。'
      : status === 'failed'
        ? '测试执行发现失败步骤，请优先检查页面状态、定位提示和测试数据。'
        : '测试被阻塞，通常由安全验证、目标页面不可访问、浏览器环境或高风险操作拦截导致。';

  const markdown = `# 测试报告：${testCase.title}

## 测试结论

状态：${statusText(status)}

${summary}

## 测试环境

- 目标地址：${testCase.targetUrl}
- 开始时间：${run.startedAt || '-'}
- 结束时间：${run.endedAt || '-'}

## 测试用例

${richTextToPlainText(testCase.content.userRequirement || '') || testCase.description}

## 执行步骤

${stepBlocks || '- 暂无执行步骤。'}

## 运行记忆与累计发现

${memory?.summary || '暂无运行记忆。'}

${memory?.findings.length ? memory.findings.map((item) => `- ${item}`).join('\n') : '- 暂无累计发现。'}

## Console 错误

${result?.consoleErrors.length ? result.consoleErrors.map((item) => `- ${item}`).join('\n') : '未采集到关键 Console 错误。'}

## 网络异常

${result?.networkErrors.length ? result.networkErrors.map((item) => `- ${item}`).join('\n') : '未采集到关键网络异常。'}

## 分析与建议

${status === 'passed' ? '- 可以将该用例加入回归测试集合。' : '- 优先检查失败步骤的执行前后截图、页面登录态、选择器和测试账号。'}
- 涉及真实支付、删除或通知发送时，请使用隔离测试环境和模拟数据。`;

  return {
    title: `测试报告：${testCase.title}`,
    summary,
    markdown,
    suggestions: [
      status === 'passed' ? '纳入回归测试。' : '检查测试环境和失败步骤证据。',
      '为关键流程补充更细粒度的断言。',
    ],
  };
}
