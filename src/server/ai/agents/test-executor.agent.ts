import type { StepExecutionResult, TestCaseRecord, TestStep } from '@/server/ai/schemas/test-case.schema';
import { BrowserSession, type BrowserActionResult } from '@/server/browser/browser-session';

function inferOperation(step: TestStep): NonNullable<TestStep['operation']> {
  if (step.operation) return step.operation;
  const text = `${step.action} ${step.selectorHint || ''}`.toLowerCase();

  if (step.input && /select|dropdown|下拉|选择/.test(text)) return 'select';
  if (step.input && /press|key|enter|按键|回车/.test(text)) return 'press';
  if (step.input) return 'fill';
  if (/wait|等待|加载/.test(text)) return 'wait';
  if (/screenshot|截图|截屏/.test(text)) return 'screenshot';
  if (/assert|expect|verify|check|看到|显示|校验|检查|验证/.test(text)) return 'assert';
  if (/click|tap|press|submit|login|open|点击|单击|提交|登录|打开/.test(text)) return 'click';
  return 'assert';
}

function blocksDangerousStep(step: TestStep) {
  if (step.riskLevel !== 'dangerous') return false;
  return process.env.ALLOW_DANGEROUS_TEST_ACTIONS !== 'true';
}

function firstMeaningfulExpectedText(step: TestStep) {
  return step.expected
    .split(/[，。,.;；\n]/)
    .map((item) => item.trim())
    .find((item) => item.length >= 2 && item.length <= 80);
}

async function performStep(session: BrowserSession, step: TestStep): Promise<BrowserActionResult> {
  const operation = inferOperation(step);

  if (blocksDangerousStep(step)) {
    return { ok: false, actual: '已阻止危险操作。需要设置 ALLOW_DANGEROUS_TEST_ACTIONS=true 后才会执行。' };
  }

  if (operation === 'click') return session.click(step.selectorHint || step.action);
  if (operation === 'fill') return session.fill(step.selectorHint || step.action, step.input || '');
  if (operation === 'select') return session.select(step.selectorHint || step.action, step.input || '');
  if (operation === 'press') return session.press(step.selectorHint, step.input || 'Enter');
  if (operation === 'wait') return session.waitForPage();
  if (operation === 'screenshot') return { ok: true, actual: '已采集截图' };

  const expectedText = firstMeaningfulExpectedText(step);
  if (!expectedText) return { ok: true, actual: '该步骤为人工语义验证，已保留页面截图与文本上下文。' };
  return session.assertVisibleText(expectedText);
}

export async function executeTestCase(testCase: TestCaseRecord, runId: string) {
  const session = new BrowserSession();
  const steps: StepExecutionResult[] = [];

  try {
    await session.start();
    await session.open(testCase.targetUrl);

    for (const step of testCase.content.steps) {
      const operation = inferOperation(step);
      const result = await performStep(session, step);
      const screenshotPath = await session.takeScreenshot(runId, step.index);
      const pageText = await session.readPageText();
      const hasPageContext = pageText.trim().length > 0;
      const blockedDangerous = blocksDangerousStep(step);

      steps.push({
        index: step.index,
        operation,
        action: step.action,
        expected: step.expected,
        actual: `${result.actual}${hasPageContext ? ` 页面可读文本 ${Math.min(pageText.length, 500)} 字符。` : ''}`,
        status: result.ok ? 'passed' : blockedDangerous ? 'blocked' : 'failed',
        screenshotPath,
      });
    }

    const failed = steps.some((step) => step.status === 'failed');
    const blocked = steps.some((step) => step.status === 'blocked');

    return {
      status: failed ? ('failed' as const) : blocked ? ('blocked' as const) : ('passed' as const),
      result: {
        steps,
        consoleErrors: session.getConsoleErrors(),
        networkErrors: session.getNetworkErrors(),
      },
    };
  } catch (error) {
    steps.push({
      index: steps.length + 1,
      action: '执行测试用例',
      expected: '浏览器可以完成测试流程',
      actual: error instanceof Error ? error.message : 'Unknown execution error',
      status: 'blocked',
    });
    return {
      status: 'blocked' as const,
      result: {
        steps,
        consoleErrors: session.getConsoleErrors(),
        networkErrors: session.getNetworkErrors(),
      },
    };
  } finally {
    await session.close();
  }
}
