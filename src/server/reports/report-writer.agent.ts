import type { TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

function escapeTableCell(value: string) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br />');
}

export function writeReport(testCase: TestCaseRecord, run: TestRunRecord) {
  const result = run.result;
  const status = run.status;
  const rows = (result?.steps || [])
    .map(
      (step) =>
        `| ${step.index} | ${step.operation || 'auto'} | ${escapeTableCell(step.action)} | ${escapeTableCell(
          step.expected,
        )} | ${escapeTableCell(step.actual)} | ${step.status} |`,
    )
    .join('\n');

  const summary =
    status === 'passed'
      ? '所有可执行步骤均已完成，未发现阻塞性问题。'
      : status === 'failed'
        ? '测试执行发现失败步骤，需要进一步修复页面行为、定位提示或测试数据。'
        : '测试被阻塞，通常由安全限制、页面不可访问、目标元素不可定位或环境问题导致。';

  const markdown = `# 测试报告：${testCase.title}

## 测试结论

状态：${status}

${summary}

## 测试环境

- 目标地址：${testCase.targetUrl}
- 开始时间：${run.startedAt || '-'}
- 结束时间：${run.endedAt || '-'}

## 测试用例

${testCase.description}

## 执行步骤

| 步骤 | 操作类型 | 操作 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|---|
${rows || '| - | - | - | - | - | - |'}

## Console 错误

${result?.consoleErrors.length ? result.consoleErrors.map((item) => `- ${item}`).join('\n') : '未采集到 Console 错误。'}

## 网络异常

${result?.networkErrors.length ? result.networkErrors.map((item) => `- ${item}`).join('\n') : '未采集到网络异常。'}

## 分析与建议

${status === 'passed' ? '- 可以将该用例加入回归测试集合。' : '- 优先检查目标地址、测试账号、页面选择器和域名白名单配置。'}
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
