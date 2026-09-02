import { NextRequest } from 'next/server';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { runtimeMetricsSnapshot } from '@/server/observability/runtime-observability';
import { databaseWriteQueueSnapshot } from '@/server/storage/database-write-queue';
import { cpuWorkerPoolSnapshot } from '@/server/runtime/cpu-worker-pool';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    if (!requestHasAdminSettingsAccess(request)) {
      throw new ApiRequestError('Administrator access is required', { code: 'admin_access_required', status: 401 });
    }
    return apiJson(request, {
      metrics: runtimeMetricsSnapshot(),
      queues: {
        cpuWorkers: cpuWorkerPoolSnapshot(),
        databaseWrites: databaseWriteQueueSnapshot(),
      },
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to read runtime metrics', status: 500 });
  }
}
