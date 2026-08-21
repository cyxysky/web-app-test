import { NextRequest } from 'next/server';
import { requireAiOperationsAdmin } from '@/server/auth/ai-operations-admin';
import { apiError, apiJson } from '@/server/http/api-request';
import { readBackendRuntimeStatus } from '@/server/observability/backend-runtime-status';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    requireAiOperationsAdmin(request);
    return apiJson(request, readBackendRuntimeStatus());
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to load backend runtime status', status: 500 });
  }
}
