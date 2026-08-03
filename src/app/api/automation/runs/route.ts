import { NextRequest } from 'next/server';
import { automationRunStatusSchema } from '@/server/automation/automation.schema';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';
import { listAutomationRuns } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  const parsedStatus = automationRunStatusSchema.safeParse(request.nextUrl.searchParams.get('status'));
  const limit = Number(request.nextUrl.searchParams.get('limit'));
  const runs = listAutomationRuns({
    userId: requestUserId(request),
    caseId: request.nextUrl.searchParams.get('caseId')?.trim() || undefined,
    scheduleId: request.nextUrl.searchParams.get('scheduleId')?.trim() || undefined,
    status: parsedStatus.success ? parsedStatus.data : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return noStoreJson({ runs });
}
