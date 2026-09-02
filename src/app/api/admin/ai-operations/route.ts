import { NextRequest } from 'next/server';
import { requireAiOperationsAdmin } from '@/server/auth/ai-operations-admin';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { readAiOperationsDashboard } from '@/server/observability/ai-operations-dashboard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function rangeDays(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get('days');
  if (requested === null) return 30;
  const value = Number(requested);
  if (value === 7 || value === 30 || value === 90) return value;
  throw new ApiRequestError('Supported ranges are 7, 30, and 90 days.', {
    code: 'invalid_ai_operations_range',
    status: 400,
  });
}

function trendUserId(request: NextRequest) {
  const value = request.nextUrl.searchParams.get('userId')?.trim();
  if (!value) return undefined;
  if (value.length <= 128) return value;
  throw new ApiRequestError('The trend user id is too long.', {
    code: 'invalid_ai_operations_user_id',
    status: 400,
  });
}

export async function GET(request: NextRequest) {
  try {
    requireAiOperationsAdmin(request);
    return apiJson(request, await readAiOperationsDashboard(rangeDays(request), trendUserId(request)));
  } catch (error) {
    return apiError(request, error, {
      fallback: 'Unable to load AI operations metrics',
      status: 500,
    });
  }
}
