import type { TestCaseContent } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

type GenerateInput = {
  prompt: string;
  systemPrompt?: string;
  targetUrl?: string;
  imageNames?: string[];
  browserMode?: TestCaseContent['browserMode'];
};

function titleFromPrompt(prompt: string) {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}...` : trimmed || 'AI 浏览器测试';
}

export async function generateTestCase(input: GenerateInput): Promise<TestCaseContent> {
  const prompt = input.prompt.trim();
  const plainPrompt = richTextToPlainText(prompt);
  const targetUrl = input.targetUrl || 'https://example.com';

  return {
    title: titleFromPrompt(plainPrompt),
    description: plainPrompt,
    targetUrl,
    userRequirement: prompt,
    systemPrompt: input.systemPrompt,
    priority: 'high',
    browserMode: input.browserMode || 'default',
    preconditions: [],
    testData: {
      userRequirement: plainPrompt,
      images: input.imageNames?.join(', ') || 'none',
      generationMode: 'runtime-ai-planning',
    },
    steps: [],
    expectedResults: [
      'AI 在运行时根据用户需求、当前页面上下文和截图判断下一步操作。',
      '每一次 AI 实际执行的操作都会被记录为运行步骤。',
      '最终页面状态由 AI 基于截图、页面文本和工具结果综合判定。',
    ],
    risks: [],
  };
}
