import { NextRequest } from 'next/server';
import {
  accessibilitySnapshotTestStatus,
  openAccessibilitySnapshotTestBrowser,
} from '@/server/browser/accessibility-snapshot-test.service';
import { apiError, apiJson } from '@/server/http/api-request';
import { requireDebugRouteAccess } from '@/server/http/debug-route-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    requireDebugRouteAccess(request);
    return apiJson(request, accessibilitySnapshotTestStatus());
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to read the DOM observation debug state', status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    requireDebugRouteAccess(request);
    const status = await openAccessibilitySnapshotTestBrowser(request.nextUrl.origin);
    return apiJson(request, status, { status: status.ok ? 200 : 500 });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to open the DOM observation debug browser', status: 500 });
  }
}
