import { generateText } from 'ai';
import { getModel } from '@/server/ai/model';
import type { StepExecutionResult, TaskFrame, TaskLedgerItem, TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { artifactsRoot } from '@/server/storage/paths';
import { artifactApiUrl } from '@/lib/artifacts';
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
  return artifactApiUrl(filePath, { artifactsRoot: artifactsRoot() });
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

function issueSummaryMarkdown(frame: TaskFrame | undefined, result: TestRunRecord['result'], limit = 80) {
  const steps = result?.steps || [];
  const ledgerItems = collectLedgerItems(result);
  const screenshotForStep = (stepIndex?: number) => {
    const step = stepIndex ? steps.find((item) => item.index === stepIndex) : undefined;
    return artifactUrl(step?.afterScreenshotPath || step?.screenshotPath || step?.beforeScreenshotPath);
  };
  const dimensionName = (id: string) => frame?.dimensions.find((dimension) => dimension.id === id)?.name || id || 'general';
  const issueLedger = ledgerItems.filter((item) => item.status === 'issue' || item.status === 'risk');
  const failedSteps = steps.filter((step) => step.status === 'failed' || step.status === 'blocked');
  const lines = [
    ...issueLedger.map((item) => {
      const screenshot = screenshotForStep(item.sourceStep);
      return [
        `- [${item.status === 'issue' ? '问题' : '风险'} / ${item.severity || 'info'} / ${dimensionName(item.dimensionId)}] ${item.title}`,
        item.summary ? `  - 理由：${compact(item.summary, 420)}` : '',
        item.expected ? `  - 期望：${compact(item.expected, 260)}` : '',
        item.actual ? `  - 实际：${compact(item.actual, 360)}` : '',
        item.sourceStep ? `  - 证据：步骤 ${item.sourceStep}` : '',
        screenshot ? `  - 问题截图：![步骤 ${item.sourceStep || ''} 问题截图](${screenshot})` : '',
        item.evidence?.length ? `  - 其他证据：${item.evidence.map((evidence) => compact(evidence, 160)).join('；')}` : '',
      ].filter(Boolean).join('\n');
    }),
    ...failedSteps.map((step) => {
      const screenshot = artifactUrl(step.afterScreenshotPath || step.screenshotPath || step.beforeScreenshotPath);
      return [
        `- [${statusText(step.status)} / 步骤 ${step.index}] ${compact(step.action, 180)}`,
        `  - 结果：${compact(step.actual, 420)}`,
        step.findings?.length ? `  - 发现：${step.findings.map((item) => compact(item, 180)).join('；')}` : '',
        screenshot ? `  - 问题截图：![步骤 ${step.index} 问题截图](${screenshot})` : '',
      ].filter(Boolean).join('\n');
    }),
    ...(result?.consoleErrors || []).map((item) => `- [Console] ${compact(item, 420)}`),
    ...(result?.networkErrors || []).map((item) => `- [网络异常] ${compact(item, 420)}`),
  ];

  if (!lines.length) return '- 本次未从步骤、结构化台账、Console 或网络记录中发现明确问题。';
  return Array.from(new Set(lines)).slice(0, limit).join('\n');
}

function contextSummaryMarkdown(result: TestRunRecord['result']) {
  const summary = result?.contextSummary || result?.contextSummaries?.at(-1);
  if (!summary) return '- 本次运行尚未触发结构化上下文压缩。';
  const section = (title: string, items?: string[]) => [
    `### ${title}`,
    items?.length ? items.map((item) => `- ${item}`).join('\n') : '- 无',
  ].join('\n');
  return [
    `- 版本：v${summary.version}`,
    `- 来源：${summary.source}`,
    `- 覆盖步骤：${summary.sourceStepRange.join(' - ')}`,
    '',
    section('具体实现目标', summary.implementationGoal),
    section('当前实现状态', summary.currentImplementationStatus),
    section('后续执行方案', summary.nextExecutionPlan),
    section('对此前的总结', summary.previousSummary),
    section('结构化台账摘要', summary.ledgerDigest),
    section('证据摘要', summary.evidenceDigest),
    section('防回退规则', summary.antiRegressionRules),
    section('阻塞点', summary.blockers),
    section('疑问点', summary.openQuestions),
    section('当前页面状态', summary.currentPageState),
  ].join('\n');
}

function coverageMatrixMarkdown(result: TestRunRecord['result']) {
  const matrix = result?.coverageMatrix || [];
  if (!matrix.length) return '- 暂无覆盖矩阵。';
  return matrix.map((item) => [
    `- [${item.status}] ${item.dimensionName} (${item.dimensionId})`,
    item.latestStep ? `  - 最新步骤：${item.latestStep}` : '',
    item.latestSummary ? `  - 摘要：${compact(item.latestSummary, 260)}` : '',
    `  - 台账项：${item.itemCount}；证据：${item.evidenceItemIds.length}`,
    item.nextAction ? `  - 下一步：${item.nextAction}` : '',
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
  const contextSummary = contextSummaryMarkdown(result);
  const coverageMatrix = coverageMatrixMarkdown(result);
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
    `覆盖矩阵：\n${coverageMatrix}`,
    '',
    `问题与风险汇总：\n${issueSummaryMarkdown(frame, result)}`,
    '',
    `结构化上下文摘要：\n${contextSummary}`,
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

function stripReportSections(markdown: string) {
  return markdown
    .replace(/\n##\s*(?:Evidence Index|证据索引|证据关系图|Evidence Graph|Run Diagnostics|运行诊断)\b[\s\S]*?(?=\n##\s+|$)/gi, '');
}

function normalizeReportMarkdown(markdown: string) {
  return stripReportSections(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/([^\n])\n(#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/(#{1,6}[^\n]+)\n(?!\n)/g, '$1\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reportQualityGrade(score: number): NonNullable<ReportRecord['quality']>['grade'] {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}

function qualityStatus(ok: boolean, warning = false): 'passed' | 'warning' | 'failed' {
  if (ok) return 'passed';
  return warning ? 'warning' : 'failed';
}

function assessReportQuality(testCase: TestCaseRecord, run: TestRunRecord, markdown: string): NonNullable<ReportRecord['quality']> {
  const result = run.result;
  const frame = collectTaskFrame(testCase, result);
  const ledgerItems = collectLedgerItems(result);
  const matrix = result?.coverageMatrix || [];
  const issueItems = ledgerItems.filter((item) => item.status === 'issue' || item.status === 'risk');
  const failedSteps = result?.steps.filter((step) => step.status === 'failed' || step.status === 'blocked') || [];
  const hasSuggestions = /建议|修复|优先级|下一步|风险/i.test(markdown);
  const checks: NonNullable<ReportRecord['quality']>['checks'] = [
    {
      id: 'coverage-matrix',
      label: '覆盖矩阵',
      status: qualityStatus(Boolean(matrix.length || frame?.dimensions.length), Boolean(frame?.dimensions.length)),
      detail: matrix.length ? `覆盖矩阵包含 ${matrix.length} 个维度。` : frame?.dimensions.length ? '有任务维度但未形成覆盖矩阵。' : '本次没有任务框架维度。',
    },
    {
      id: 'ledger-items',
      label: '结构化台账',
      status: qualityStatus(ledgerItems.length > 0),
      detail: ledgerItems.length ? `包含 ${ledgerItems.length} 条台账项。` : '缺少结构化台账，报告复核能力较弱。',
    },
    {
      id: 'issue-review',
      label: '问题复核',
      status: qualityStatus(Boolean(issueItems.length || !failedSteps.length), Boolean(failedSteps.length)),
      detail: issueItems.length
        ? `包含 ${issueItems.length} 条问题/风险台账。`
        : failedSteps.length
          ? '存在失败或阻塞步骤，但缺少问题/风险台账。'
          : '未发现失败步骤或明确问题。',
    },
    {
      id: 'recommendations',
      label: '建议与下一步',
      status: qualityStatus(hasSuggestions, run.status === 'passed'),
      detail: hasSuggestions ? '报告包含建议、修复或下一步信息。' : '报告缺少建议或下一步信息。',
    },
    {
      id: 'context-summary',
      label: '上下文摘要',
      status: qualityStatus(Boolean(result?.contextSummary || result?.contextSummaries?.length), true),
      detail: result?.contextSummary || result?.contextSummaries?.length ? '包含结构化上下文摘要。' : '未触发或未记录结构化上下文摘要。',
    },
  ];

  const perCheck = checks.length ? 100 / checks.length : 100;
  const score = Math.max(0, Math.min(100, Math.round(checks.reduce((sum, check) => {
    if (check.status === 'passed') return sum + perCheck;
    if (check.status === 'warning') return sum + perCheck * 0.5;
    return sum;
  }, 0))));

  return {
    score,
    grade: reportQualityGrade(score),
    reviewedAt: new Date().toISOString(),
    checks,
  };
}

export function writeReport(testCase: TestCaseRecord, run: TestRunRecord): ReportRecord {
  const result = run.result;
  const taskFrame = collectTaskFrame(testCase, result);
  const ledgerItems = collectLedgerItems(result);
  const stepBlocks = (result?.steps || []).map(stepMarkdown).join('\n\n');
  const contextSummary = contextSummaryMarkdown(result);
  const coverageMatrix = coverageMatrixMarkdown(result);
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

## 覆盖矩阵

${coverageMatrix}

## 问题与风险汇总

${issueSummaryMarkdown(taskFrame, result)}

## 结构化上下文摘要

${contextSummary}

## 执行步骤与证据

${stepBlocks || '- 暂无执行步骤。'}

## Console 错误

${result?.consoleErrors.length ? result.consoleErrors.map((item) => `- ${item}`).join('\n') : '- 未采集到关键 Console 错误。'}

## 网络异常

${result?.networkErrors.length ? result.networkErrors.map((item) => `- ${item}`).join('\n') : '- 未采集到关键网络异常。'}
`;
  const normalizedMarkdown = normalizeReportMarkdown(markdown);
  return {
    title: `测试报告：${testCase.title}`,
    summary,
    markdown: normalizedMarkdown,
    suggestions: [],
    quality: assessReportQuality(testCase, run, normalizedMarkdown),
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
        '- 使用中文 Markdown 便于存储，但内容要面向结构化报告展示，不要输出调试统计。',
        '- 报告必须详细，不要空泛总结。',
        '- “AI 总结”是任务交付的重要组成部分，需要概括已读内容、关键业务规则、测试覆盖、未覆盖项和最终判断。',
        '- 必须单独总结测试过程中发现的问题、风险、影响范围和证据步骤；没有明确问题时也要说明“未发现明确问题”。',
        '- 如果用户要求输出测试用例，必须生成完整测试流程：前置条件、测试数据、操作步骤、断言、异常/边界、风险。',
        '- 只能基于提供的事实和台账，不要编造未实际读取到的页面细节。',
        '- 不要输出“测试用例生成状态”这类无意义状态，要输出具体测试内容。',
        '- 保留必要的截图链接或步骤编号作为证据引用。',
        '- 不要输出 Evidence Index、证据索引、运行诊断或证据关系图段落。',
        '',
        '建议结构：',
        '# 测试报告：标题',
        '## AI 总结',
        '## 需求理解与关键规则',
        '## 完整测试流程',
        '## 详细测试用例',
        '## 覆盖矩阵与台账结论',
        '## 问题与风险汇总',
        '## 结构化上下文摘要',
        '## 疑问与未覆盖项',
        '## 执行步骤与证据',
        '',
        context,
      ].join('\n'),
    });
    const markdown = result.text.trim();
    if (!markdown) return fallback;
    const contextSummary = contextSummaryMarkdown(run.result);
    const markdownWithContextSummary = /##\s*结构化上下文摘要/.test(markdown)
      ? markdown
      : `${markdown}\n\n## 结构化上下文摘要\n\n${contextSummary}`;
    const normalizedMarkdown = normalizeReportMarkdown(markdownWithContextSummary);
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
      markdown: normalizedMarkdown,
      quality: assessReportQuality(testCase, run, normalizedMarkdown),
    };
  } catch {
    return fallback;
  }
}
