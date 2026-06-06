import path from 'node:path';
import { generateText } from 'ai';
import { getModel } from '@/server/ai/model';
import type { StepExecutionResult, TaskFrame, TaskLedgerItem, TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

type ReportRecord = NonNullable<TestRunRecord['report']>;

function statusText(status: TestRunRecord['status'] | StepExecutionResult['status']) {
  if (status === 'passed') return '通过';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '阻塞';
  if (status === 'running') return '运行中';
  return '排队中';
}

function artifactUrl(filePath?: string) {
  if (!filePath) return undefined;
  const root = path.resolve(process.cwd(), 'artifacts');
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  if (relative.startsWith('..')) return undefined;
  return `/api/artifacts/${relative}`;
}

function compact(value?: string, max = 900) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sameDisplayText(a?: string, b?: string) {
  const left = (a || '').replace(/\s+/g, ' ').trim();
  const right = (b || '').replace(/\s+/g, ' ').trim();
  return Boolean(left && right && left === right);
}

function taskLedgerKey(item: TaskLedgerItem) {
  return item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
}

function collectTaskFrame(testCase: TestCaseRecord, result: TestRunRecord['result']) {
  return result?.taskFrame
    || result?.steps.map((step) => step.taskFrame || step.workingMemory?.taskFrame).filter(Boolean).at(-1)
    || testCase.content.taskFrame;
}

function collectLedgerItems(result: TestRunRecord['result']) {
  const map = new Map<string, TaskLedgerItem>();
  for (const item of [
    ...(result?.ledgerItems || []),
    ...(result?.steps || []).flatMap((step) => step.ledgerItems || []),
    ...(result?.steps || []).flatMap((step) => step.workingMemory?.ledgerItems || []),
  ]) {
    map.set(taskLedgerKey(item), item);
  }
  return [...map.values()];
}

function formatToolInput(input: unknown) {
  if (input === undefined || input === null) return '';
  const value = typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => !['taskFrameJson', 'ledgerItemsJson'].includes(key)))
    : input;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function taskFrameMarkdown(frame?: TaskFrame) {
  if (!frame) return '- 本次运行未形成结构化任务框架。';
  const dimensionLines = frame.dimensions.map((dimension) => [
    `- ${dimension.name}（${dimension.id}）：${dimension.description || '无描述'}`,
    dimension.focus?.length ? `  - 关注点：${dimension.focus.join('；')}` : '',
    dimension.testIdeas?.length ? `  - 测试思路：${dimension.testIdeas.join('；')}` : '',
    dimension.risks?.length ? `  - 风险：${dimension.risks.join('；')}` : '',
  ].filter(Boolean).join('\n'));
  return [
    `- 目标：${frame.goal}`,
    frame.successCriteria.length ? `- 成功标准：\n${frame.successCriteria.map((item) => `  - ${item}`).join('\n')}` : '',
    frame.deliverables?.length ? `- 交付物：\n${frame.deliverables.map((item) => `  - ${item}`).join('\n')}` : '',
    frame.analysisGuidance?.length ? `- 分析指引：\n${frame.analysisGuidance.map((item) => `  - ${item}`).join('\n')}` : '',
    frame.finalOutputRequirements?.length ? `- 最终输出要求：\n${frame.finalOutputRequirements.map((item) => `  - ${item}`).join('\n')}` : '',
    dimensionLines.length ? `- 覆盖维度：\n${dimensionLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function ledgerMarkdown(frame: TaskFrame | undefined, items: TaskLedgerItem[], limit = Number(process.env.AI_FINAL_REPORT_LEDGER_LIMIT || 240)) {
  if (!items.length) return '- 暂无结构化台账。';
  const dimensionName = (id: string) => frame?.dimensions.find((dimension) => dimension.id === id)?.name || id || 'general';
  return items.slice(-limit).map((item) => [
    `- [${dimensionName(item.dimensionId)} / ${item.status || 'finding'} / ${item.severity || 'info'}] ${item.title}${item.sourceStep ? `（步骤 ${item.sourceStep}）` : ''}`,
    item.summary ? `  - 摘要：${item.summary}` : '',
    item.expected ? `  - 期望：${item.expected}` : '',
    item.actual ? `  - 实际：${item.actual}` : '',
    item.attributes?.length ? `  - 属性：${item.attributes.map((pair) => `${pair.key}=${pair.value}`).join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

function stepMarkdown(step: StepExecutionResult) {
  const before = artifactUrl(step.beforeScreenshotPath);
  const after = artifactUrl(step.afterScreenshotPath || step.screenshotPath);
  const observation = step.observation && !sameDisplayText(step.observation, step.action) ? step.observation : '';
  const tools = step.tools?.length
    ? step.tools.map((tool) => `  - ${tool.name}${tool.reason ? `：${tool.reason}` : ''}${tool.result ? `；结果：${compact(tool.result, 260)}` : ''}${formatToolInput(tool.input) ? `；参数：${formatToolInput(tool.input)}` : ''}`).join('\n')
    : '  - 无';
  return [
    `### 步骤 ${step.index}：${step.action}`,
    `- 状态：${statusText(step.status)}`,
    `- 结果：${compact(step.actual, 700)}`,
    observation ? `- 页面观察：${compact(observation, 700)}` : '',
    step.findings?.length ? `- 关键发现：\n${step.findings.map((item) => `  - ${item}`).join('\n')}` : '',
    step.ledgerItems?.length ? `- 本步台账：\n${ledgerMarkdown(undefined, step.ledgerItems, 40)}` : '',
    `- 工具调用：\n${tools}`,
    before ? `![步骤 ${step.index} 执行前](${before})` : '',
    after ? `![步骤 ${step.index} 执行后](${after})` : '',
  ].filter(Boolean).join('\n');
}

function reportContext(testCase: TestCaseRecord, run: TestRunRecord) {
  const result = run.result;
  const frame = collectTaskFrame(testCase, result);
  const ledger = collectLedgerItems(result);
  const steps = result?.steps || [];
  return [
    `运行状态：${statusText(run.status)}`,
    `目标地址：${testCase.targetUrl}`,
    `用户需求：\n${richTextToPlainText(testCase.content.userRequirement || '') || testCase.description}`,
    testCase.content.systemPrompt ? `AI 操作提示词：\n${richTextToPlainText(testCase.content.systemPrompt)}` : '',
    '',
    `任务框架：\n${taskFrameMarkdown(frame)}`,
    '',
    `结构化台账：\n${ledgerMarkdown(frame, ledger)}`,
    '',
    `执行步骤：\n${steps.map((step) => [
      `步骤 ${step.index} [${statusText(step.status)}] ${step.action}`,
      `结果：${compact(step.actual, 500)}`,
      step.observation ? `观察：${compact(step.observation, 500)}` : '',
      step.findings?.length ? `发现：${step.findings.join('；')}` : '',
      step.tools?.length ? `工具：${step.tools.map((tool) => `${tool.name}${tool.reason ? `(${tool.reason})` : ''}`).join('；')}` : '',
    ].filter(Boolean).join('\n')).join('\n\n')}`,
    result?.consoleErrors.length ? `Console 错误：\n${result.consoleErrors.join('\n')}` : '',
    result?.networkErrors.length ? `网络异常：\n${result.networkErrors.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function fallbackSummary(status: TestRunRecord['status']) {
  if (status === 'passed') return '任务已完成。请以结构化台账和步骤证据为准复核需求覆盖情况。';
  if (status === 'failed') return '任务执行失败。请优先检查失败步骤、页面状态、账号数据和未覆盖台账项。';
  return '任务被阻塞或中断。请查看阻塞步骤、人工介入信息和未覆盖台账项。';
}

export function writeReport(testCase: TestCaseRecord, run: TestRunRecord): ReportRecord {
  const result = run.result;
  const taskFrame = collectTaskFrame(testCase, result);
  const ledgerItems = collectLedgerItems(result);
  const stepBlocks = (result?.steps || []).map(stepMarkdown).join('\n\n');
  const summary = fallbackSummary(run.status);
  const markdown = `# 测试报告：${testCase.title}

## AI 总结

${summary}

## 用户需求

${richTextToPlainText(testCase.content.userRequirement || '') || testCase.description}

## 任务框架

${taskFrameMarkdown(taskFrame)}

## 结构化台账

${ledgerMarkdown(taskFrame, ledgerItems)}

## 执行步骤与证据

${stepBlocks || '- 暂无执行步骤。'}

## Console 错误

${result?.consoleErrors.length ? result.consoleErrors.map((item) => `- ${item}`).join('\n') : '- 未采集到关键 Console 错误。'}

## 网络异常

${result?.networkErrors.length ? result.networkErrors.map((item) => `- ${item}`).join('\n') : '- 未采集到关键网络异常。'}
`;
  return {
    title: `测试报告：${testCase.title}`,
    summary,
    markdown,
    suggestions: [],
  };
}

export async function writeAiReport(testCase: TestCaseRecord, run: TestRunRecord): Promise<ReportRecord> {
  const fallback = writeReport(testCase, run);
  if (process.env.AI_FINAL_REPORT_SUMMARY === 'false') return fallback;
  try {
    const context = reportContext(testCase, run);
    const result = await generateText({
      model: getModel(),
      temperature: 0.2,
      maxRetries: 0,
      prompt: [
        '你是资深测试负责人。请基于下面的运行事实，生成最终交付报告。',
        '',
        '要求：',
        '- 使用中文 Markdown。',
        '- 报告必须详细，不要空泛总结。',
        '- “AI 总结”是任务交付的重要组成部分，需要概括已读内容、关键业务规则、测试覆盖、未覆盖项和最终判断。',
        '- 如果用户要求输出测试用例，必须生成完整测试流程：前置条件、测试数据、操作步骤、断言、异常/边界、风险。',
        '- 只能基于提供的事实和台账，不要编造未实际读取到的页面细节。',
        '- 不要输出“测试用例生成状态”这类无意义状态，要输出具体测试内容。',
        '- 保留必要的截图链接或步骤编号作为证据引用。',
        '',
        '建议结构：',
        '# 测试报告：标题',
        '## AI 总结',
        '## 需求理解与关键规则',
        '## 完整测试流程',
        '## 详细测试用例',
        '## 覆盖矩阵与台账结论',
        '## 风险、疑问与未覆盖项',
        '## 执行步骤与证据',
        '',
        context,
      ].join('\n'),
    });
    const markdown = result.text.trim();
    if (!markdown) return fallback;
    const summary = markdown
      .replace(/^# .+$/m, '')
      .split(/\n## /)[0]
      .replace(/#+\s*AI 总结/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600) || fallback.summary;
    return {
      ...fallback,
      summary,
      markdown,
    };
  } catch {
    return fallback;
  }
}
