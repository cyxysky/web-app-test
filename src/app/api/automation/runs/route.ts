import { NextRequest } from 'next/server';
import { automationRunStatusSchema } from '@/server/automation/automation.schema';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { apiJson, boundedQueryInteger } from '@/server/http/api-request';
import { listAutomationRuns } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const parsedStatus = automationRunStatusSchema.safeParse(request.nextUrl.searchParams.get('status'));
  return apiJson(request, {
    runs: listAutomationRuns({
      userId: requestApplicationUserId(request),
      caseId: request.nextUrl.searchParams.get('caseId')?.trim() || undefined,
      scheduleId: request.nextUrl.searchParams.get('scheduleId')?.trim() || undefined,
      status: parsedStatus.success ? parsedStatus.data : undefined,
      limit: boundedQueryInteger(request.nextUrl.searchParams.get('limit'), { fallback: 100, max: 500 }),
    }),
  });
}
