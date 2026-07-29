import { NextRequest, NextResponse } from 'next/server';
import { runtimeEnvDefinitions } from '@/config/settings';
import { store } from '@/server/db/store';
import { readRuntimeSettingsItems } from '@/server/settings/settings-snapshot';

const allowedKeys = new Set(runtimeEnvDefinitions.map((item) => item.key));
const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  return NextResponse.json({ saved: readRuntimeSettingsItems() }, { headers: noStoreHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const incoming = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    const incomingByKey = new Map(incoming
      .filter((item) => item && typeof item.key === 'string' && allowedKeys.has(item.key))
      .map((item) => [String(item.key), item]));
    const savedByKey = new Map(store.listRuntimeEnv().map((item) => [item.key, item]));
    const sanitized = runtimeEnvDefinitions.map((definition) => {
      const item = incomingByKey.get(definition.key);
      const secret = Boolean(definition.secret);
      const submittedValue = typeof item?.value === 'string' ? item.value : '';
      return {
        key: definition.key,
        value: secret && !submittedValue
          ? savedByKey.get(definition.key)?.value ?? definition.defaultValue
          : typeof item?.value === 'string' ? submittedValue : definition.defaultValue,
        enabled: true,
        secret,
      };
    });
    store.saveRuntimeEnv(sanitized);
    store.applyRuntimeEnv();
    return NextResponse.json({ ok: true, saved: readRuntimeSettingsItems() }, { headers: noStoreHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存环境配置失败' },
      { status: 400, headers: noStoreHeaders },
    );
  }
}
