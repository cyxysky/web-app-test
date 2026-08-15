import { ApiRequestError } from '@/server/http/api-request';
import { requestApplicationPrincipal, type ApplicationPrincipal } from '@/server/auth/user-context';

export const AI_OPERATIONS_ADMIN_USER_ID = '1';

export function isAiOperationsAdmin(userId: unknown) {
  return String(userId ?? '').trim() === AI_OPERATIONS_ADMIN_USER_ID;
}

export function requireAiOperationsAdmin(request: Pick<Request, 'headers'>): ApplicationPrincipal {
  const principal = requestApplicationPrincipal(request);
  if (!isAiOperationsAdmin(principal.userId)) {
    throw new ApiRequestError('AI operations administrator access is required', {
      code: 'ai_operations_admin_required',
      status: 403,
    });
  }
  return principal;
}
