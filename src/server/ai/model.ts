import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';


const openAI = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'http://mirrors.shterm.com:8801/openai',
  apiKey: process.env.OPENAI_API_KEY || '-',
  compatibility: 'compatible',
  name: 'mirror-openai',
});

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
});

export function getModel() {
  return openrouter.chat("qwen/qwen3.6-plus")
  return deepseek("deepseek-v4-flash");
}
