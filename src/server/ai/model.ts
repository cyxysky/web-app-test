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
  // z-ai/glm-5.1
  // qwen/qwen3.6-plus
  // deepseek/deepseek-v4-pro
  // qwen/qwen3.7-max
  // moonshotai/kimi-k2.6
  // xiaomi/mimo-v2.5
  // openai/gpt-5.4
  // x-ai/grok-4.3
  // x-ai/grok-build-0.1
  return openrouter.chat("x-ai/grok-4.3")
  return deepseek("deepseek-v4-flash");
}
