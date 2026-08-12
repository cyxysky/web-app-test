import { z } from 'zod';
import { webPilotOnboardingSteps } from '@/lib/onboarding';

export const onboardingRequestSchema = z.object({
  action: z.enum(['complete', 'complete_step', 'reset', 'skip', 'start']),
  step: z.enum(webPilotOnboardingSteps).optional(),
}).superRefine((value, context) => {
  if (value.action === 'complete_step' && !value.step) {
    context.addIssue({ code: 'custom', message: 'step is required for complete_step', path: ['step'] });
  }
});
