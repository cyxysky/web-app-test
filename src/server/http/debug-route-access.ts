import { requestApplicationPrincipal } from '@/server/auth/user-context';
import { ApiRequestError } from '@/server/http/api-request';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

type DebugRouteEnvironment = NodeJS.ProcessEnv & {
  NODE_ENV?: string;
  WEBPILOT_DEBUG_ROUTES_ENABLED?: string;
};

export function debugRoutesEnabled(environment: DebugRouteEnvironment = process.env) {
  const configured = String(environment.WEBPILOT_DEBUG_ROUTES_ENABLED || '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return environment.NODE_ENV !== 'production';
}

export function requireDebugRouteAccess(request: Request) {
  if (!debugRoutesEnabled()) {
    throw new ApiRequestError('Not found', { code: 'not_found', status: 404 });
  }
  requestApplicationPrincipal(request);
  if (!requestHasAdminSettingsAccess(request)) {
    throw new ApiRequestError('Administrator access is required', {
      code: 'admin_access_required',
      status: 401,
    });
  }
}
