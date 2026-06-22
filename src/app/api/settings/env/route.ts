import { NextRequest, NextResponse } from 'next/server';
import { runtimeEnvDefinitions } from '@/config/settings';
import { store } from '@/server/db/mock-store';

const allowedKeys = new Set(runtimeEnvDefinitions.map((item) => item.key));
const legacyCustomPromptKeys = {
  browserEnabled: 'AI_BROWSER_CHAT_CUSTOM_PROMPT_ENABLED',
  browserPrompt: 'AI_BROWSER_CHAT_CUSTOM_PROMPT',
  targetEnabled: 'AI_TARGET_MODE_CUSTOM_PROMPT_ENABLED',
  targetPrompt: 'AI_TARGET_MODE_CUSTOM_PROMPT',
};

function legacyCustomSystemPrompt(savedByKey: ReadonlyMap<string, { value?: string }>) {
  const targetPrompt = savedByKey.get(legacyCustomPromptKeys.targetPrompt)?.value?.trim();
  const browserPrompt = savedByKey.get(legacyCustomPromptKeys.browserPrompt)?.value?.trim();
  if (savedByKey.get(legacyCustomPromptKeys.targetEnabled)?.value === 'true' && targetPrompt) return targetPrompt;
  if (savedByKey.get(legacyCustomPromptKeys.browserEnabled)?.value === 'true' && browserPrompt) return browserPrompt;
  return '';
}

function defaultRuntimeItems() {
  return runtimeEnvDefinitions.map((definition) => ({
    key: definition.key,
    value: definition.defaultValue,
    enabled: true,
    secret: Boolean(definition.secret),
  }));
}

function mergedRuntimeItems() {
  const savedByKey = new Map(store.listRuntimeEnv().map((item) => [item.key, item]));
  const migratedCustomSystemPrompt = legacyCustomSystemPrompt(savedByKey);
  return defaultRuntimeItems().map((item) => {
    const saved = savedByKey.get(item.key);
    const migratedValue = item.key === 'AI_CUSTOM_SYSTEM_PROMPT' ? migratedCustomSystemPrompt : '';
    return {
      ...item,
      value: saved?.value ?? (migratedValue || item.value),
      enabled: true,
      secret: saved?.secret ?? item.secret,
      updatedAt: saved?.updatedAt,
    };
  });
}

export async function GET() {
  store.applyRuntimeEnv();
  return NextResponse.json({ saved: mergedRuntimeItems() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const incoming = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    const incomingByKey = new Map(incoming
      .filter((item) => item && typeof item.key === 'string' && allowedKeys.has(item.key))
      .map((item) => [String(item.key), item]));
    const sanitized = runtimeEnvDefinitions.map((definition) => {
      const item = incomingByKey.get(definition.key);
      return {
        key: definition.key,
        value: typeof item?.value === 'string' ? item.value : definition.defaultValue,
        enabled: true,
        secret: Boolean(definition.secret),
      };
    });
    const saved = store.saveRuntimeEnv(sanitized);
    store.applyRuntimeEnv();
    return NextResponse.json({ ok: true, saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存环境配置失败' },
      { status: 400 },
    );
  }
}
