export const WEBPILOT_ONBOARDING_VERSION = 2;
export const WEBPILOT_ONBOARDING_RESTART_EVENT = 'webpilot:onboarding-restart';

export const webPilotOnboardingSteps = [
  'welcome',
  'accounts',
  'skills',
  'memory',
  'permissions',
  'model',
  'readiness',
  'browser_task',
] as const;

export type WebPilotOnboardingStep = typeof webPilotOnboardingSteps[number];
export type WebPilotOnboardingStatus = 'completed' | 'dismissed' | 'in_progress' | 'not_started';

export type WebPilotOnboardingState = {
  completedSteps: WebPilotOnboardingStep[];
  dismissedAt?: string;
  status: WebPilotOnboardingStatus;
  tutorialVersion: number;
  updatedAt: string;
};

export type WebPilotOnboardingReadiness = {
  browser: { detail: string; ready: boolean };
  libreOffice: { detail: string; ready: boolean };
  model: { detail: string; ready: boolean };
  vision: { detail: string; ready: boolean };
};

export function isWebPilotOnboardingStep(value: unknown): value is WebPilotOnboardingStep {
  return webPilotOnboardingSteps.includes(value as WebPilotOnboardingStep);
}
