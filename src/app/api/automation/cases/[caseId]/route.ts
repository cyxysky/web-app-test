import { NextRequest } from 'next/server';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';
import {
  deleteAutomationCase,
  getAutomationCase,
} from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ caseId: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { caseId } = await context.params;
  const automationCase = getAutomationCase(caseId, requestUserId(request));
  if (!automationCase) {
    return noStoreJson({ error: 'Automation case not found.' }, { status: 404 });
  }
  if (request.nextUrl.searchParams.get('download') === '1') {
    return noStoreJson(automationCase, {
      headers: {
        'Content-Disposition': `attachment; filename="automation-case-${automationCase.id}.json"`,
      },
    });
  }
  return noStoreJson({ case: automationCase, automationCase });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { caseId } = await context.params;
  const userId = requestUserId(request);
  const automationCase = getAutomationCase(caseId, userId);
  if (!automationCase || !deleteAutomationCase(caseId, userId)) {
    return noStoreJson({ error: 'Automation case not found.' }, { status: 404 });
  }
  return noStoreJson({ ok: true, deleted: { id: automationCase.id }, case: automationCase, automationCase });
}
