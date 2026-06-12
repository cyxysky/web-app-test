import type { TestCaseContent, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/sqlite-store';

const evaluationGroupName = '最小稳定性评测集';

type EvaluationCaseTemplate = {
  key: string;
  content: TestCaseContent;
};

export const minimalEvaluationCases: EvaluationCaseTemplate[] = [
  {
    key: 'dom-basic-navigation',
    content: {
      title: '[Eval] DOM 模式基础导航',
      description: '使用 DOM 模式打开 example.com，确认页面标题、说明文字和 More information 链接可被读取。',
      targetUrl: 'https://example.com',
      priority: 'medium',
      browserMode: 'dom',
      isMarked: false,
      userRequirement: '打开 example.com，使用 DOM 模式确认页面标题包含 Example Domain，正文说明可读，并识别 More information 链接。',
      systemPrompt: '这是稳定性评测用例。优先使用 DOM 快照和 DOM 工具，不要依赖视觉候选编号。',
      preconditions: ['网络可访问 example.com。'],
      testData: { evaluationKey: 'dom-basic-navigation', evaluationArea: 'dom-mode' },
      steps: [],
      expectedResults: ['DOM 模式可稳定读取页面文本。', 'AI 能正确完成基础导航与断言。'],
      risks: ['外部站点不可达时该评测会受网络影响。'],
      taskFrame: {
        goal: '验证 DOM 模式基础导航稳定性。',
        successCriteria: ['页面标题被确认', '正文说明被确认', '链接存在性被确认'],
        dimensions: [
          { id: 'dom_text', name: 'DOM 文本读取' },
          { id: 'navigation', name: '基础导航' },
          { id: 'assertion', name: '完成断言' },
        ],
        version: 1,
      },
    },
  },
  {
    key: 'visual-marker-basic',
    content: {
      title: '[Eval] 视觉标记基础操作',
      description: '使用视觉标记模式打开 example.com，基于截图确认页面关键元素。',
      targetUrl: 'https://example.com',
      priority: 'medium',
      browserMode: 'visual-markers',
      isMarked: true,
      userRequirement: '打开 example.com，使用视觉标记模式确认页面标题、正文和 More information 入口在截图中可见。',
      systemPrompt: '这是视觉模式稳定性评测。只使用当前截图里的候选编号，不能复用历史编号。',
      preconditions: ['网络可访问 example.com。'],
      testData: { evaluationKey: 'visual-marker-basic', evaluationArea: 'visual-markers' },
      steps: [],
      expectedResults: ['视觉标记截图能被正确使用。', 'AI 不把 marker 编号误认为业务含义。'],
      risks: ['模型不支持图片输入时会退化为候选摘要。'],
      taskFrame: {
        goal: '验证视觉标记模式的基础页面理解。',
        successCriteria: ['截图证据存在', '页面标题被确认', '视觉候选使用符合规则'],
        dimensions: [
          { id: 'visual_context', name: '视觉上下文' },
          { id: 'marker_rule', name: 'Marker 规则遵守' },
          { id: 'evidence', name: '截图证据' },
        ],
        version: 1,
      },
    },
  },
  {
    key: 'long-context-summary',
    content: {
      title: '[Eval] 长上下文压缩保真',
      description: '要求 AI 分多轮沉淀目标、进度、证据和待办，用于观察 context summary 是否保真。',
      targetUrl: 'https://example.com',
      priority: 'high',
      browserMode: 'default',
      isMarked: true,
      userRequirement: [
        '打开 example.com 后，围绕页面标题、正文、链接、当前 URL、可见状态、网络错误和证据截图分别形成检查结论。',
        '每一类检查都要在结构化台账中留下覆盖或发现。',
        '如果上下文接近阈值，压缩后仍必须保留目标、已覆盖维度、证据摘要和下一步计划。',
      ].join('\n'),
      systemPrompt: '这是长上下文压缩评测。每步都要明确当前覆盖维度，不要在压缩后丢失目标和证据摘要。',
      preconditions: ['网络可访问 example.com。'],
      testData: { evaluationKey: 'long-context-summary', evaluationArea: 'context-summary' },
      steps: [],
      expectedResults: ['运行结果包含 context summary。', '台账和证据摘要能覆盖所有要求维度。'],
      risks: ['如果上下文阈值设置很高，可能不会触发压缩，但仍可评估结构化摘要质量。'],
      taskFrame: {
        goal: '验证长任务在压缩前后保留目标、进度和证据。',
        successCriteria: ['目标未丢失', '台账维度完整', '证据摘要可追溯', '下一步计划明确'],
        dimensions: [
          { id: 'goal_retention', name: '目标保真' },
          { id: 'progress_retention', name: '进度保真' },
          { id: 'evidence_retention', name: '证据保真' },
          { id: 'next_plan', name: '后续计划' },
        ],
        version: 1,
      },
    },
  },
  {
    key: 'browser-chat-export',
    content: {
      title: '[Eval] Browser-chat 可复用探索记录',
      description: '用于验收 browser-chat 的探索记录是否能导出为可复用用例。',
      targetUrl: 'https://example.com',
      priority: 'medium',
      browserMode: 'visual-markers',
      isMarked: true,
      userRequirement: '以 browser-chat 的验收视角打开 example.com，确认一次对话操作能形成步骤、日志和截图证据，并可导出为普通测试用例。',
      systemPrompt: '这是 browser-chat 可复用探索记录评测。关注步骤、日志、截图证据和导出用例的完整性。',
      preconditions: ['先在左侧新对话中完成一次 example.com 探索，再使用导出用例能力。'],
      testData: { evaluationKey: 'browser-chat-export', evaluationArea: 'browser-chat' },
      steps: [],
      expectedResults: ['对话记录包含可审计步骤。', '导出用例可在目标模式里看到并运行。'],
      risks: ['该项需要结合 browser-chat 交互入口人工验收。'],
      taskFrame: {
        goal: '验证 browser-chat 探索记录能沉淀为可复用测试资产。',
        successCriteria: ['对话有步骤', '日志可查看', '截图证据可追溯', '可导出普通用例'],
        dimensions: [
          { id: 'chat_steps', name: '对话步骤' },
          { id: 'chat_logs', name: '执行日志' },
          { id: 'export_case', name: '导出用例' },
          { id: 'evidence_chain', name: '证据链' },
        ],
        version: 1,
      },
    },
  },
];

function isCompletedRun(run: TestRunRecord) {
  return run.status === 'passed' || run.status === 'failed' || run.status === 'blocked';
}

function runDurationMs(run?: TestRunRecord) {
  if (!run?.startedAt || !run.endedAt) return undefined;
  const startedAt = new Date(run.startedAt).getTime();
  const endedAt = new Date(run.endedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return undefined;
  return endedAt - startedAt;
}

function passRate(passed: number, completed: number) {
  return completed ? Math.round((passed / completed) * 100) : 0;
}

function trendFromRuns(completedRuns: TestRunRecord[], windowSize = 5) {
  const recent = completedRuns.slice(0, windowSize);
  const previous = completedRuns.slice(windowSize, windowSize * 2);
  const recentPassRate = passRate(recent.filter((run) => run.status === 'passed').length, recent.length);
  const previousPassRate = passRate(previous.filter((run) => run.status === 'passed').length, previous.length);
  const delta = previous.length ? recentPassRate - previousPassRate : undefined;
  const status = !recent.length
    ? 'no-data'
    : !previous.length
      ? 'baseline'
      : delta !== undefined && delta <= -20
        ? 'regressed'
        : delta !== undefined && delta >= 20
          ? 'improved'
          : 'stable';
  return {
    windowSize,
    recentRuns: recent.length,
    previousRuns: previous.length,
    recentPassRate,
    previousPassRate: previous.length ? previousPassRate : undefined,
    delta,
    status,
  };
}

function contextSummaryScore(run?: TestRunRecord) {
  const summary = run?.result?.contextSummary;
  if (!summary) return undefined;
  const checks = [
    summary.implementationGoal.length > 0,
    summary.currentImplementationStatus.length > 0,
    summary.nextExecutionPlan.length > 0,
    summary.ledgerDigest.length > 0,
    summary.evidenceDigest.length > 0,
    summary.antiRegressionRules.length > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function alert(level: 'info' | 'warning' | 'danger', title: string, detail: string) {
  return { level, title, detail };
}

export async function seedMinimalEvaluationSuite() {
  const [groups, testCases] = await Promise.all([
    store.listGroups(),
    store.listTestCases(),
  ]);
  let group = groups.find((item) => item.name === evaluationGroupName && !item.parentId);
  if (!group) group = await store.createGroup(evaluationGroupName);

  const created = [];
  const skipped = [];
  for (const template of minimalEvaluationCases) {
    const existing = testCases.find((item) =>
      item.content.testData?.evaluationKey === template.key || item.title === template.content.title
    );
    if (existing) {
      skipped.push(existing);
      continue;
    }
    created.push(await store.createTestCase(template.content, [], group.id));
  }

  return {
    group,
    created,
    skipped,
    totalTemplates: minimalEvaluationCases.length,
  };
}

export async function getEvaluationSuiteStatus() {
  const [groups, testCases] = await Promise.all([
    store.listGroups(),
    store.listTestCases(),
  ]);
  const group = groups.find((item) => item.name === evaluationGroupName && !item.parentId);
  const cases = await Promise.all(minimalEvaluationCases.map(async (template) => {
    const testCase = testCases.find((item) =>
      item.content.testData?.evaluationKey === template.key || item.title === template.content.title
    );
    const runs = testCase ? await store.listRunsForTestCase(testCase.id) : [];
    const completedRuns = runs.filter(isCompletedRun);
    const passedRuns = completedRuns.filter((run) => run.status === 'passed');
    const failedRuns = completedRuns.filter((run) => run.status === 'failed');
    const blockedRuns = completedRuns.filter((run) => run.status === 'blocked');
    const durations = completedRuns.map(runDurationMs).filter((value): value is number => typeof value === 'number');
    const latestRun = completedRuns[0] || runs[0];
    const trend = trendFromRuns(completedRuns);
    const latestContextSummaryScore = contextSummaryScore(latestRun);

    return {
      key: template.key,
      area: template.content.testData?.evaluationArea || template.key,
      title: template.content.title,
      testCaseId: testCase?.id,
      status: testCase?.status || 'missing',
      runCount: runs.length,
      completedRunCount: completedRuns.length,
      passedRunCount: passedRuns.length,
      failedRunCount: failedRuns.length,
      blockedRunCount: blockedRuns.length,
      passRate: passRate(passedRuns.length, completedRuns.length),
      averageDurationMs: durations.length
        ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
        : undefined,
      trend,
      latestRun: latestRun ? {
        id: latestRun.id,
        status: latestRun.status,
        startedAt: latestRun.startedAt,
        endedAt: latestRun.endedAt,
        qualityScore: latestRun.report?.quality?.score,
        contextSummaryScore: latestContextSummaryScore,
      } : undefined,
    };
  }));

  const completedRunCount = cases.reduce((total, item) => total + item.completedRunCount, 0);
  const passedRunCount = cases.reduce((total, item) => total + item.passedRunCount, 0);
  const failedRunCount = cases.reduce((total, item) => total + item.failedRunCount, 0);
  const blockedRunCount = cases.reduce((total, item) => total + item.blockedRunCount, 0);
  const durations = cases.map((item) => item.averageDurationMs).filter((value): value is number => typeof value === 'number');
  const allCompletedRuns = (await Promise.all(cases
    .filter((item) => item.testCaseId)
    .map((item) => store.listRunsForTestCase(item.testCaseId as string))))
    .flat()
    .filter(isCompletedRun)
    .sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));
  const trend = trendFromRuns(allCompletedRuns);
  const areas = Array.from(cases.reduce((map, item) => {
    const current = map.get(item.area) || {
      area: item.area,
      totalCases: 0,
      seededCases: 0,
      completedRunCount: 0,
      passedRunCount: 0,
      failedRunCount: 0,
      blockedRunCount: 0,
    };
    current.totalCases += 1;
    if (item.testCaseId) current.seededCases += 1;
    current.completedRunCount += item.completedRunCount;
    current.passedRunCount += item.passedRunCount;
    current.failedRunCount += item.failedRunCount;
    current.blockedRunCount += item.blockedRunCount;
    map.set(item.area, current);
    return map;
  }, new Map<string, {
    area: string;
    totalCases: number;
    seededCases: number;
    completedRunCount: number;
    passedRunCount: number;
    failedRunCount: number;
    blockedRunCount: number;
  }>()).values()).map((area) => ({
    ...area,
    passRate: passRate(area.passedRunCount, area.completedRunCount),
  }));
  const alerts = [
    cases.some((item) => !item.testCaseId)
      ? alert('info', '评测集未完整创建', `还有 ${cases.filter((item) => !item.testCaseId).length} 条模板未创建。`)
      : undefined,
    completedRunCount === 0
      ? alert('info', '暂无评测运行', '创建最小评测集后，至少运行一次才能形成稳定性基线。')
      : undefined,
    completedRunCount >= 3 && passRate(passedRunCount, completedRunCount) < 80
      ? alert('warning', '整体通过率偏低', `当前完成运行通过率为 ${passRate(passedRunCount, completedRunCount)}%。`)
      : undefined,
    trend.status === 'regressed'
      ? alert('danger', '评测趋势下滑', `最近 ${trend.recentRuns} 次通过率较前一窗口下降 ${Math.abs(trend.delta || 0)} 个百分点。`)
      : undefined,
    ...cases.flatMap((item) => {
      const latestStatus = item.latestRun?.status;
      return [
        latestStatus === 'failed' || latestStatus === 'blocked'
          ? alert('warning', `${item.title} 最近未通过`, `最近一次运行状态为 ${latestStatus === 'blocked' ? '阻塞' : '失败'}。`)
          : undefined,
        typeof item.latestRun?.qualityScore === 'number' && item.latestRun.qualityScore < 75
          ? alert('warning', `${item.title} 报告质量偏低`, `最近报告质量分为 ${item.latestRun.qualityScore}。`)
          : undefined,
        item.area === 'context-summary' && typeof item.latestRun?.contextSummaryScore === 'number' && item.latestRun.contextSummaryScore < 80
          ? alert('warning', `${item.title} 压缩摘要偏弱`, `最近 context summary 保真评分为 ${item.latestRun.contextSummaryScore}。`)
          : undefined,
        item.trend.status === 'regressed'
          ? alert('danger', `${item.title} 趋势下滑`, `最近窗口通过率下降 ${Math.abs(item.trend.delta || 0)} 个百分点。`)
          : undefined,
      ];
    }),
  ].filter((item): item is ReturnType<typeof alert> => Boolean(item)).slice(0, 8);

  return {
    group: group ? { id: group.id, name: group.name } : undefined,
    totalTemplates: minimalEvaluationCases.length,
    seededCases: cases.filter((item) => Boolean(item.testCaseId)).length,
    missingCases: cases.filter((item) => !item.testCaseId).length,
    totalRuns: cases.reduce((total, item) => total + item.runCount, 0),
    completedRunCount,
    passedRunCount,
    failedRunCount,
    blockedRunCount,
    passRate: passRate(passedRunCount, completedRunCount),
    trend,
    alerts,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : undefined,
    areas,
    cases,
  };
}
