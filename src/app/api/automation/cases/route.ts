import { NextRequest } from 'next/server';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';
import { createAutomationCase, listAutomationCases } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RequestBody = Record<string, unknown>;

function bodyRecord(value: unknown): RequestBody {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RequestBody : {};
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

function requestLimit(request: NextRequest) {
  const value = Number(request.nextUrl.searchParams.get('limit'));
  return Number.isFinite(value) ? value : undefined;
}

export async function GET(request: NextRequest) {
  const cases = listAutomationCases({
    userId: requestUserId(request),
    sourceSessionId: request.nextUrl.searchParams.get('sourceSessionId')?.trim() || undefined,
    limit: requestLimit(request),
  });
  return noStoreJson({ cases });
}

export async function POST(request: NextRequest) {
  try {
    const body = bodyRecord(await request.json().catch(() => ({})));
    const title = text(body.title ?? body.name);
    const instruction = text(body.instruction ?? body.prompt);
    if (!title) throw new Error('Automation case title is required.');
    if (!instruction) throw new Error('Automation case instruction is required.');
    const userId = requestUserId(request);
    const automationCase = createAutomationCase({
      userId,
      title,
      description: text(body.description) || undefined,
      sourceSessionId: 'manual',
      sourceMessageIds: [],
      targetUrl: text(body.targetUrl ?? body.url) || 'about:blank',
      instruction,
      mode: 'code',
      operations: [],
    });
    return noStoreJson({
      ok: true,
      case: automationCase,
      automationCase,
      cases: listAutomationCases({ userId }),
    }, { status: 201 });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to create automation case.' },
      { status: 400 },
    );
  }
}
