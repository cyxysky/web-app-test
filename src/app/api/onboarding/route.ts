import { NextRequest } from 'next/server';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { onboardingRequestSchema } from '@/server/http/onboarding-request.schema';
import { readOnboardingReadiness, readOnboardingState, updateOnboardingState } from '@/server/onboarding/onboarding-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const userId = requestApplicationUserId(request);
    const [state, readiness] = await Promise.all([
      Promise.resolve(readOnboardingState(userId)),
      readOnboardingReadiness(),
    ]);
    return apiJson(request, { readiness, state });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to read onboarding state' });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, onboardingRequestSchema, { maxBytes: 8 * 1024 });
    const state = updateOnboardingState(requestApplicationUserId(request), body);
    return apiJson(request, { state });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to update onboarding state' });
  }
}
