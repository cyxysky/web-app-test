import { generateText } from 'ai';
import { z } from 'zod';
import { testCaseContentSchema, type TestCaseContent } from '@/server/ai/schemas/test-case.schema';
import { getModel } from '@/server/ai/model';

type GenerateInput = {
  prompt: string;
  targetUrl?: string;
  imageNames?: string[];
};

function fallbackTestCase(input: GenerateInput): TestCaseContent {
  const targetUrl = input.targetUrl || 'https://example.com';
  return {
    title: 'AI 生成测试用例',
    description: input.prompt || '根据用户输入生成的端到端测试用例。',
    targetUrl,
    priority: 'high',
    preconditions: ['测试环境可以访问', '测试账号和测试数据已准备', '目标域名在安全白名单内'],
    testData: {
      prompt: input.prompt,
      images: input.imageNames?.join(', ') || 'none',
    },
    steps: [
      {
        index: 1,
        operation: 'wait',
        action: `打开目标页面 ${targetUrl} 并等待主要内容加载`,
        expected: '页面正常加载，没有阻塞性错误',
        riskLevel: 'safe',
      },
      {
        index: 2,
        operation: 'click',
        action: '点击页面上的主要入口、按钮或链接',
        selectorHint: 'button, link, primary action, visible text',
        expected: '页面对点击操作产生可见响应',
        riskLevel: 'safe',
      },
      {
        index: 3,
        operation: 'fill',
        action: '在主要输入框中输入用户指定的测试内容',
        selectorHint: 'input, textarea, textbox, search, label, placeholder',
        input: input.prompt,
        expected: '输入内容被正确填入，页面没有报错',
        riskLevel: 'safe',
      },
      {
        index: 4,
        operation: 'assert',
        action: '检查页面反馈、跳转、错误提示和关键内容',
        expected: '关键反馈可见，流程结果可被验证',
        riskLevel: 'safe',
      },
    ],
    expectedResults: ['目标页面可访问', '指定业务流程可执行', '最终反馈符合预期'],
    risks: ['模型不可用或返回格式异常时会使用本地 fallback，用例步骤会更通用。'],
  };
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] || text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start < 0 || end < start) {
    throw new Error('模型没有返回 JSON 对象');
  }

  return JSON.parse(raw.slice(start, end + 1));
}

function schemaPrompt(input: GenerateInput) {
  return [
    '你是资深 QA 自动化测试专家。',
    '请根据用户提示词、目标 URL 和图片上下文生成可执行的端到端浏览器测试用例。',
    '只返回一个 JSON 对象，不要使用 Markdown，不要添加解释。',
    'JSON 必须符合以下 TypeScript 形状：',
    `{
  "title": "string",
  "description": "string",
  "targetUrl": "string",
  "priority": "low" | "medium" | "high" | "critical",
  "preconditions": ["string"],
  "testData": { "key": "value" },
  "steps": [{
    "index": 1,
    "operation": "open" | "click" | "fill" | "select" | "press" | "assert" | "wait" | "screenshot",
    "action": "string",
    "selectorHint": "可选。Playwright 易定位提示：可见文本、label、placeholder、role 名称或 CSS selector",
    "input": "可选。只用于 fill、select、press",
    "expected": "string",
    "riskLevel": "safe" | "warning" | "dangerous"
  }],
  "expectedResults": ["string"],
  "risks": ["string"]
}`,
    '步骤必须具体、可验证，并标记高风险操作。',
    '禁止建议真实支付、删除生产数据、发送真实通知或提交不可逆操作。',
    '',
    `目标 URL: ${input.targetUrl || '用户未提供'}`,
    `需求: ${input.prompt}`,
    `用户上传图片: ${input.imageNames?.join(', ') || '无'}`,
  ].join('\n');
}

function describeAiError(error: unknown) {
  if (!(error instanceof Error)) return '未知错误';
  const details = error as Error & {
    reason?: string;
    lastError?: { message?: string; url?: string; statusCode?: number };
  };
  const status = details.lastError?.statusCode ? `HTTP ${details.lastError.statusCode}` : undefined;
  const url = details.lastError?.url ? `URL ${details.lastError.url}` : undefined;
  const reason = details.reason ? `原因 ${details.reason}` : undefined;
  return [error.message, status, reason, url].filter(Boolean).join('；');
}

export async function generateTestCase(input: GenerateInput) {
  try {
    const result = await generateText({
      model: getModel(),
      prompt: schemaPrompt(input),
      maxRetries: 0,
      temperature: 0.2,
    });

    return testCaseContentSchema.parse(extractJson(result.text));
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn('AI returned invalid test-case JSON, falling back:', error.flatten());
    } else {
      console.warn(`AI generation unavailable, using local fallback. ${describeAiError(error)}`);
    }
    return fallbackTestCase(input);
  }
}
