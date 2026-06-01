import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { generateText } from 'ai';
import { createAzure } from "@ai-sdk/azure";

type GenerateTextModel = Parameters<typeof generateText>[0]['model'];
/**
 * openai的gpt模型
 */
const openAI = createAzure({
  baseURL: 'http://mirrors.shterm.com:8801/openai',
  apiKey: '-',
});

const ccmodel = openAI("gpt-5.4");

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
});

export function getModel(): any {
  // return ccmodel;
  const { provider, model } = getModelSettings();
  if (provider === 'deepseek') return deepseek(model) as unknown as GenerateTextModel;
  if (provider === 'openai') return openAI(model) as unknown as GenerateTextModel;
  return openrouter.chat(model) as GenerateTextModel;
}

export function getModelSettings() {
  const provider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  const normalizedProvider = provider === 'deepseek' || provider === 'openai' ? provider : 'openrouter';
  const defaults = {
    deepseek: 'deepseek-v4-flash',
    openai: 'gpt-4o',
    openrouter: 'qwen/qwen3.6-plus',
  } as const;

  return {
    provider: normalizedProvider,
    model: process.env.AI_MODEL || defaults[normalizedProvider],
  };
}
