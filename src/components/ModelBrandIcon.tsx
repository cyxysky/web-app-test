'use client';

import { Bot } from 'lucide-react';
import type { StaticImageData } from 'next/image';
import type { ModelProvider } from '@/server/ai/schemas/runtime.schema';

import anthropicDark from '@lobehub/icons-static-png/dark/claude-color.png';
import anthropicLight from '@lobehub/icons-static-png/light/claude-color.png';
import azureDark from '@lobehub/icons-static-png/dark/azureai-color.png';
import azureLight from '@lobehub/icons-static-png/light/azureai-color.png';
import bedrockDark from '@lobehub/icons-static-png/dark/bedrock-color.png';
import bedrockLight from '@lobehub/icons-static-png/light/bedrock-color.png';
import cerebrasDark from '@lobehub/icons-static-png/dark/cerebras-color.png';
import cerebrasLight from '@lobehub/icons-static-png/light/cerebras-color.png';
import cohereDark from '@lobehub/icons-static-png/dark/cohere-color.png';
import cohereLight from '@lobehub/icons-static-png/light/cohere-color.png';
import deepseekDark from '@lobehub/icons-static-png/dark/deepseek-color.png';
import deepseekLight from '@lobehub/icons-static-png/light/deepseek-color.png';
import fireworksDark from '@lobehub/icons-static-png/dark/fireworks-color.png';
import fireworksLight from '@lobehub/icons-static-png/light/fireworks-color.png';
import geminiDark from '@lobehub/icons-static-png/dark/gemini-color.png';
import geminiLight from '@lobehub/icons-static-png/light/gemini-color.png';
import grokDark from '@lobehub/icons-static-png/dark/grok.png';
import grokLight from '@lobehub/icons-static-png/light/grok.png';
import groqDark from '@lobehub/icons-static-png/dark/groq.png';
import groqLight from '@lobehub/icons-static-png/light/groq.png';
import huggingFaceDark from '@lobehub/icons-static-png/dark/huggingface-color.png';
import huggingFaceLight from '@lobehub/icons-static-png/light/huggingface-color.png';
import lmStudioDark from '@lobehub/icons-static-png/dark/lmstudio.png';
import lmStudioLight from '@lobehub/icons-static-png/light/lmstudio.png';
import metaDark from '@lobehub/icons-static-png/dark/meta-color.png';
import metaLight from '@lobehub/icons-static-png/light/meta-color.png';
import minimaxDark from '@lobehub/icons-static-png/dark/minimax-color.png';
import minimaxLight from '@lobehub/icons-static-png/light/minimax-color.png';
import mistralDark from '@lobehub/icons-static-png/dark/mistral-color.png';
import mistralLight from '@lobehub/icons-static-png/light/mistral-color.png';
import ollamaDark from '@lobehub/icons-static-png/dark/ollama.png';
import ollamaLight from '@lobehub/icons-static-png/light/ollama.png';
import openaiDark from '@lobehub/icons-static-png/dark/openai.png';
import openaiLight from '@lobehub/icons-static-png/light/openai.png';
import openrouterDark from '@lobehub/icons-static-png/dark/openrouter.png';
import openrouterLight from '@lobehub/icons-static-png/light/openrouter.png';
import perplexityDark from '@lobehub/icons-static-png/dark/perplexity-color.png';
import perplexityLight from '@lobehub/icons-static-png/light/perplexity-color.png';
import qwenDark from '@lobehub/icons-static-png/dark/qwen-color.png';
import qwenLight from '@lobehub/icons-static-png/light/qwen-color.png';
import togetherDark from '@lobehub/icons-static-png/dark/together-color.png';
import togetherLight from '@lobehub/icons-static-png/light/together-color.png';
import vercelDark from '@lobehub/icons-static-png/dark/vercel.png';
import vercelLight from '@lobehub/icons-static-png/light/vercel.png';
import zhipuDark from '@lobehub/icons-static-png/dark/zhipu-color.png';
import zhipuLight from '@lobehub/icons-static-png/light/zhipu-color.png';

type BrandIcon = {
  dark: StaticImageData;
  label: string;
  light: StaticImageData;
};

const brands = {
  anthropic: { dark: anthropicDark, label: 'Anthropic Claude', light: anthropicLight },
  azure: { dark: azureDark, label: 'Azure AI', light: azureLight },
  bedrock: { dark: bedrockDark, label: 'Amazon Bedrock', light: bedrockLight },
  cerebras: { dark: cerebrasDark, label: 'Cerebras', light: cerebrasLight },
  cohere: { dark: cohereDark, label: 'Cohere', light: cohereLight },
  deepseek: { dark: deepseekDark, label: 'DeepSeek', light: deepseekLight },
  fireworks: { dark: fireworksDark, label: 'Fireworks AI', light: fireworksLight },
  gemini: { dark: geminiDark, label: 'Google Gemini', light: geminiLight },
  grok: { dark: grokDark, label: 'xAI Grok', light: grokLight },
  groq: { dark: groqDark, label: 'Groq', light: groqLight },
  huggingface: { dark: huggingFaceDark, label: 'Hugging Face', light: huggingFaceLight },
  lmstudio: { dark: lmStudioDark, label: 'LM Studio', light: lmStudioLight },
  meta: { dark: metaDark, label: 'Meta Llama', light: metaLight },
  minimax: { dark: minimaxDark, label: 'MiniMax', light: minimaxLight },
  mistral: { dark: mistralDark, label: 'Mistral AI', light: mistralLight },
  ollama: { dark: ollamaDark, label: 'Ollama', light: ollamaLight },
  openai: { dark: openaiDark, label: 'OpenAI', light: openaiLight },
  openrouter: { dark: openrouterDark, label: 'OpenRouter', light: openrouterLight },
  perplexity: { dark: perplexityDark, label: 'Perplexity', light: perplexityLight },
  qwen: { dark: qwenDark, label: 'Alibaba Qwen', light: qwenLight },
  together: { dark: togetherDark, label: 'Together AI', light: togetherLight },
  vercel: { dark: vercelDark, label: 'Vercel', light: vercelLight },
  zhipu: { dark: zhipuDark, label: 'Zhipu GLM', light: zhipuLight },
} satisfies Record<string, BrandIcon>;

type BrandName = keyof typeof brands;

const modelMatchers: Array<[RegExp, BrandName]> = [
  [/deepseek/i, 'deepseek'],
  [/minimax/i, 'minimax'],
  [/(?:^|[/_.-])(?:gpt|chatgpt|o[134])(?:$|[/_.-])|codex/i, 'openai'],
  [/claude|anthropic/i, 'anthropic'],
  [/gemini|gemma/i, 'gemini'],
  [/qwen|qwq|tongyi/i, 'qwen'],
  [/llama|meta[-_/ ]?llama/i, 'meta'],
  [/mistral|mixtral|codestral/i, 'mistral'],
  [/grok|xai/i, 'grok'],
  [/command[-_ ]?[ar]|cohere/i, 'cohere'],
  [/sonar|perplexity/i, 'perplexity'],
  [/glm|zhipu|chatglm/i, 'zhipu'],
];

const providerBrands: Partial<Record<ModelProvider, BrandName>> = {
  'ai-gateway': 'vercel',
  'alibaba': 'qwen',
  'anthropic': 'anthropic',
  'azure-openai': 'azure',
  'bedrock': 'bedrock',
  'cerebras': 'cerebras',
  'codex': 'openai',
  'cohere': 'cohere',
  'deepseek': 'deepseek',
  'fireworks': 'fireworks',
  'google': 'gemini',
  'groq': 'groq',
  'huggingface': 'huggingface',
  'llama-cpp': 'meta',
  'lmstudio': 'lmstudio',
  'minimax': 'minimax',
  'mistral': 'mistral',
  'ollama': 'ollama',
  'openai': 'openai',
  'openrouter': 'openrouter',
  'perplexity': 'perplexity',
  'togetherai': 'together',
  'vercel': 'vercel',
  'xai': 'grok',
};

export function modelBrandName(model: string, provider: ModelProvider): BrandName | undefined {
  const match = modelMatchers.find(([pattern]) => pattern.test(model.trim()));
  return match?.[1] || providerBrands[provider];
}

export function ModelBrandIcon({ model, provider }: { model: string; provider: ModelProvider }) {
  const brandName = modelBrandName(model, provider);
  const brand = brandName ? brands[brandName] : undefined;
  if (!brand) return <Bot aria-label="AI model" size={16} />;
  return (
    <span aria-label={brand.label} className="model-brand-icon-images" role="img">
      <img alt="" className="model-brand-icon-light" src={brand.light.src} />
      <img alt="" className="model-brand-icon-dark" src={brand.dark.src} />
    </span>
  );
}
