import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/db/mock-store';

const protectedKeys = new Set(['NODE_ENV', 'PWD', 'PATH', 'SystemRoot', 'WINDIR']);

export async function GET() {
  const saved = store.listRuntimeEnv();
  const savedKeys = new Set(saved.map((item) => item.key));
  const processItems = Object.entries(process.env)
    .filter(([key]) => !savedKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      value: value || '',
      enabled: false,
      secret: /KEY|TOKEN|SECRET|PASSWORD|COOKIE/i.test(key),
      readonly: protectedKeys.has(key),
      source: 'process',
    }));

  return NextResponse.json({
    saved,
    process: processItems,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    const sanitized = items
      .filter((item) => item && typeof item.key === 'string' && !protectedKeys.has(item.key))
      .map((item) => ({
        key: String(item.key),
        value: typeof item.value === 'string' ? item.value : '',
        enabled: item.enabled !== false,
        secret: Boolean(item.secret),
      }));
    const saved = store.saveRuntimeEnv(sanitized);
    store.applyRuntimeEnv();
    return NextResponse.json({ ok: true, saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存环境变量失败' },
      { status: 400 },
    );
  }
}
