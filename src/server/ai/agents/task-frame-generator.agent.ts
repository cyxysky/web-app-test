import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/server/ai/model';
import { taskFrameSchema, type TaskFrame } from '@/server/ai/schemas/test-case.schema';
import { richTextToPlainText } from '@/lib/rich-text';

type GenerateTaskFrameInput = {
  userRequirement: string;
  systemPrompt?: string;
  targetUrl?: string;
};

const generatedTaskFrameSchema = taskFrameSchema.extend({
  successCriteria: z.array(z.string()).min(4).max(12),
  dimensions: z.array(z.object({
    id: z.string().min(2).max(60),
    name: z.string().min(2).max(80),
    description: z.string().min(8).max(500).optional(),
    focus: z.array(z.string()).min(2).max(12).optional(),
    testIdeas: z.array(z.string()).min(2).max(12).optional(),
    risks: z.array(z.string()).max(8).optional(),
  })).min(4).max(10),
  deliverables: z.array(z.string()).min(2).max(12).optional(),
  analysisGuidance: z.array(z.string()).min(3).max(12).optional(),
  finalOutputRequirements: z.array(z.string()).min(3).max(12).optional(),
});

function normalizeId(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

export async function generateTaskFrame(input: GenerateTaskFrameInput): Promise<TaskFrame> {
  const requirement = richTextToPlainText(input.userRequirement).trim();
  const systemPrompt = richTextToPlainText(input.systemPrompt || '').trim();
  const targetUrl = input.targetUrl || '';

  const result = await generateObject({
    model: getModel(),
    schema: generatedTaskFrameSchema,
    temperature: 0.2,
    prompt: [
      '你是资深测试分析师。请基于用户需求和 AI 操作提示词，生成一个“内容分析与测试设计框架”。',
      '',
      '重要规则：',
      '- 框架必须服务于用户最终交付物，不是浏览器执行进度面板。',
      '- dimensions 必须是需求内容/业务规则/测试覆盖轴，不允许写成“登录状态”“阅读进度”“测试用例生成状态”这类执行状态。',
      '- 如果用户要求完整阅读需求/产品方案并输出测试用例，框架要覆盖：需求内容解析、业务规则、端到端流程、数据/权限/状态、异常边界、测试用例与断言、风险疑问。',
      '- 不要编造目标页面里的未知业务细节；未知内容写成后续阅读时必须补齐的分析方向。',
      '- 每个 dimension 要给出 description、focus、testIdeas，便于运行时 AI 把每页内容沉淀到结构化台账。',
      '- successCriteria 和 finalOutputRequirements 要具体说明最终总结/测试用例必须达到的详细程度。',
      '',
      `目标地址：${targetUrl || '[未提供]'}`,
      '',
      `用户需求：\n${requirement}`,
      '',
      `AI 操作提示词：\n${systemPrompt || '[无]'}`,
    ].join('\n'),
  });

  const frame = result.object;
  return {
    ...frame,
    version: frame.version || 1,
    dimensions: frame.dimensions.map((dimension, index) => ({
      ...dimension,
      id: normalizeId(dimension.id || dimension.name, `dimension_${index + 1}`),
    })),
  };
}
