import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';

export type ModelCapabilities = {
  imageInput: boolean;
};

const imageModelIdPattern = /(?:^|[\/_-])(vision|vl|multimodal|pixtral)(?:$|[\/_-])|(?:^|[\/_-])(?:gpt-(?:4o|4\.1|5)|claude-(?:3|4)|gemini|grok-(?:2-vision|4))(?:$|[\/_-])/i;

/**
 * Migration/default only. Provider model-list endpoints do not expose a
 * portable modality schema, so runtime decisions use the persisted per-model
 * capability whenever it exists.
 */
export function defaultModelCapabilities(provider: ModelProvider, model: string): ModelCapabilities {
  const normalizedModel = model.trim();
  if (!normalizedModel) return { imageInput: false };
  if (provider === 'google' || provider === 'anthropic' || provider === 'openai' || provider === 'codex') {
    return { imageInput: true };
  }
  return { imageInput: imageModelIdPattern.test(normalizedModel) };
}

export function modelCapabilities(
  settings: ModelProviderSettings | undefined,
  provider: ModelProvider,
  model: string,
): ModelCapabilities {
  const configured = settings?.modelCapabilities?.[model];
  return {
    imageInput: typeof configured?.imageInput === 'boolean'
      ? configured.imageInput
      : defaultModelCapabilities(provider, model).imageInput,
  };
}

export function normalizedModelCapabilities(
  provider: ModelProvider,
  models: string[],
  configured?: ModelProviderSettings['modelCapabilities'],
): Record<string, ModelCapabilities> {
  return Object.fromEntries(models.map((model) => [
    model,
    {
      imageInput: typeof configured?.[model]?.imageInput === 'boolean'
        ? configured[model].imageInput
        : defaultModelCapabilities(provider, model).imageInput,
    },
  ]));
}
