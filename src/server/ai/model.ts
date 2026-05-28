import { createOpenAI } from '@ai-sdk/openai';

/**
 * OpenAI-compatible GPT model through the internal mirror.
 *
 * The mirror exposes an OpenAI-style chat endpoint. Using the Azure provider with
 * baseURL builds deployment URLs such as /openai/{model}/chat/completions, which
 * can make the mirror close the socket before it returns a response.
 */
const openAI = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'http://mirrors.shterm.com:8801/openai',
  apiKey: process.env.OPENAI_API_KEY || '-',
  compatibility: 'compatible',
  name: 'mirror-openai',
});

export function getModel() {
  return openAI.chat(process.env.AI_MODEL || 'gpt-5.4', {
    structuredOutputs: false,
  });
}
