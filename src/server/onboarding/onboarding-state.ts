import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  WEBPILOT_ONBOARDING_VERSION,
  isWebPilotOnboardingStep,
  webPilotOnboardingSteps,
  type WebPilotOnboardingReadiness,
  type WebPilotOnboardingState,
  type WebPilotOnboardingStatus,
  type WebPilotOnboardingStep,
} from '@/lib/onboarding';
import { modelProviderDefinition } from '@/config/settings';
import { getSqliteDatabase } from '@/server/storage/sqlite-database';
import { readModelSettingsState } from '@/server/settings/settings-snapshot';
import { resolveLibreOfficeExecutable } from '@/server/files/libreoffice';
import { store } from '@/server/db/store';

type OnboardingRow = {
  completed_steps_json: string;
  dismissed_at: string | null;
  status: string;
  tutorial_version: number;
  updated_at: string;
};

function completedStepsFromJson(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown[];
    return Array.isArray(parsed) ? parsed.filter(isWebPilotOnboardingStep) : [];
  } catch {
    return [];
  }
}

function stateFromRow(row: OnboardingRow): WebPilotOnboardingState {
  const status: WebPilotOnboardingStatus = ['completed', 'dismissed', 'in_progress', 'not_started'].includes(row.status)
    ? row.status as WebPilotOnboardingStatus
    : 'not_started';
  return {
    completedSteps: completedStepsFromJson(row.completed_steps_json),
    dismissedAt: row.dismissed_at || undefined,
    status,
    tutorialVersion: row.tutorial_version,
    updatedAt: row.updated_at,
  };
}

function userHasExistingWork(userId: string) {
  const database = getSqliteDatabase();
  const row = database.prepare(`
    SELECT
      EXISTS(
        SELECT 1 FROM browser_chat_message AS message
        JOIN browser_chat_session AS session ON session.id = message.session_id
        WHERE session.user_id = ?
        LIMIT 1
      ) AS has_messages,
      EXISTS(
        SELECT 1 FROM automation_case WHERE user_id = ? LIMIT 1
      ) AS has_automation
  `).get(userId, userId) as { has_automation: number; has_messages: number };
  return Boolean(row.has_messages || row.has_automation);
}

export function readOnboardingState(userId: string) {
  const database = getSqliteDatabase();
  const existing = database.prepare(`
    SELECT tutorial_version, status, completed_steps_json, dismissed_at, updated_at
    FROM user_onboarding_state
    WHERE user_id = ?
  `).get(userId) as OnboardingRow | undefined;
  if (existing) return stateFromRow(existing);

  const timestamp = new Date().toISOString();
  const legacyComplete = userHasExistingWork(userId);
  const completedSteps = legacyComplete ? [...webPilotOnboardingSteps] : [];
  database.prepare(`
    INSERT INTO user_onboarding_state (
      user_id, tutorial_version, status, completed_steps_json, dismissed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(
    userId,
    WEBPILOT_ONBOARDING_VERSION,
    legacyComplete ? 'completed' : 'not_started',
    JSON.stringify(completedSteps),
    timestamp,
    timestamp,
  );
  return {
    completedSteps,
    status: legacyComplete ? 'completed' as const : 'not_started' as const,
    tutorialVersion: WEBPILOT_ONBOARDING_VERSION,
    updatedAt: timestamp,
  };
}

function writeOnboardingState(userId: string, input: {
  completedSteps: WebPilotOnboardingStep[];
  dismissedAt?: string;
  status: WebPilotOnboardingStatus;
}) {
  const timestamp = new Date().toISOString();
  getSqliteDatabase().prepare(`
    INSERT INTO user_onboarding_state (
      user_id, tutorial_version, status, completed_steps_json, dismissed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      tutorial_version = excluded.tutorial_version,
      status = excluded.status,
      completed_steps_json = excluded.completed_steps_json,
      dismissed_at = excluded.dismissed_at,
      updated_at = excluded.updated_at
  `).run(
    userId,
    WEBPILOT_ONBOARDING_VERSION,
    input.status,
    JSON.stringify(Array.from(new Set(input.completedSteps)).filter(isWebPilotOnboardingStep)),
    input.dismissedAt || null,
    timestamp,
    timestamp,
  );
  return readOnboardingState(userId);
}

export function updateOnboardingState(userId: string, input: {
  action: 'complete' | 'complete_step' | 'reset' | 'skip' | 'start';
  step?: WebPilotOnboardingStep;
}) {
  const current = readOnboardingState(userId);
  if (input.action === 'reset') return writeOnboardingState(userId, { completedSteps: [], status: 'not_started' });
  if (input.action === 'skip') return writeOnboardingState(userId, {
    completedSteps: current.completedSteps,
    dismissedAt: new Date().toISOString(),
    status: 'dismissed',
  });
  if (input.action === 'complete') return writeOnboardingState(userId, {
    completedSteps: [...webPilotOnboardingSteps],
    status: 'completed',
  });
  if (input.action === 'start') return writeOnboardingState(userId, {
    completedSteps: Array.from(new Set([...current.completedSteps, 'welcome', 'readiness'])),
    status: 'in_progress',
  });
  if (!input.step) throw new Error('complete_step requires a valid onboarding step.');
  const completedSteps = Array.from(new Set([...current.completedSteps, input.step]));
  const requiredSteps: WebPilotOnboardingStep[] = ['welcome', 'readiness', 'browser_task'];
  return writeOnboardingState(userId, {
    completedSteps,
    status: requiredSteps.every((step) => completedSteps.includes(step)) ? 'completed' : 'in_progress',
  });
}

export async function readOnboardingReadiness(): Promise<WebPilotOnboardingReadiness> {
  store.applyRuntimeEnv();
  const modelState = readModelSettingsState();
  const provider = modelState.config.provider;
  const providerDefinition = modelProviderDefinition(provider);
  const providerSettings = modelState.config.providers?.[provider];
  const localProvider = ['codex', 'llama-cpp', 'lmstudio', 'ollama'].includes(provider);
  const modelReady = Boolean(providerSettings?.model && (providerDefinition.localAuth || localProvider || providerSettings.hasApiKey));
  const screenshotSetting = String(process.env.SEND_SCREENSHOT_TO_AI || '').trim().toLowerCase();
  const selectedModel = String(providerSettings?.model || '').toLowerCase();
  const visionReady = screenshotSetting === 'true'
    || (screenshotSetting !== 'false' && provider !== 'deepseek' && !selectedModel.startsWith('deepseek'));
  const libreOfficeExecutable = await resolveLibreOfficeExecutable();
  let browserReady = false;
  try {
    browserReady = existsSync(chromium.executablePath());
  } catch {
    browserReady = false;
  }
  return {
    browser: {
      detail: browserReady ? 'Playwright 浏览器运行时已安装' : '未找到 Playwright 浏览器运行时',
      ready: browserReady,
    },
    libreOffice: {
      detail: libreOfficeExecutable ? 'LibreOffice 可用于 Office 预览与格式转换' : '未找到 LibreOffice，Office 预览和旧格式导出会受限',
      ready: Boolean(libreOfficeExecutable),
    },
    model: {
      detail: modelReady ? `${provider} / ${providerSettings?.model}` : '尚未完成可用模型配置',
      ready: modelReady,
    },
    vision: {
      detail: visionReady ? '当前模型配置支持图片输入' : '当前模型配置未启用图片输入',
      ready: visionReady,
    },
  };
}
