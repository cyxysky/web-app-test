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
import { modelCapabilities } from '@/lib/model-capabilities';
import { enabledModelProviders } from '@/lib/model-selection';
import { getSqliteDatabase } from '@/server/storage/sqlite-database';
import { readModelSettingsState } from '@/server/settings/settings-snapshot';
import {
  resolveLibreOfficeExecutable,
  resolveLibreOfficePythonExecutable,
} from '@/server/files/libreoffice';
import { resolveUnoProgramWorker } from '@/server/files/uno-program';
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

export function readOnboardingState(userId: string): WebPilotOnboardingState {
  const database = getSqliteDatabase();
  const existing = database.prepare(`
    SELECT tutorial_version, status, completed_steps_json, dismissed_at, updated_at
    FROM user_onboarding_state
    WHERE user_id = ?
  `).get(userId) as OnboardingRow | undefined;
  if (existing) {
    if (existing.tutorial_version === WEBPILOT_ONBOARDING_VERSION) return stateFromRow(existing);
    return writeOnboardingState(userId, { completedSteps: [], status: 'not_started' });
  }

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
}): WebPilotOnboardingState {
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
    completedSteps: current.completedSteps,
    status: 'in_progress',
  });
  if (!input.step) throw new Error('complete_step requires a valid onboarding step.');
  const completedSteps = Array.from(new Set([...current.completedSteps, input.step]));
  return writeOnboardingState(userId, {
    completedSteps,
    status: webPilotOnboardingSteps.every((step) => completedSteps.includes(step)) ? 'completed' : 'in_progress',
  });
}

export async function readOnboardingReadiness(): Promise<WebPilotOnboardingReadiness> {
  store.applyRuntimeEnv();
  const modelState = readModelSettingsState();
  const configuredProvider = modelState.config.provider;
  const provider = modelState.config.providers?.[configuredProvider]?.enabled
    ? configuredProvider
    : enabledModelProviders(modelState.config)[0] || configuredProvider;
  const providerDefinition = modelProviderDefinition(provider);
  const providerSettings = modelState.config.providers?.[provider];
  const localProvider = ['codex', 'llama-cpp', 'lmstudio', 'ollama'].includes(provider);
  const customCompatibleReady = provider.startsWith('openai-compatible') && Boolean(providerSettings?.baseURL);
  const modelReady = Boolean(providerSettings?.enabled && providerSettings.model && (
    providerDefinition.localAuth || localProvider || customCompatibleReady || providerSettings.hasApiKey
  ));
  const screenshotSetting = String(process.env.SEND_SCREENSHOT_TO_AI || '').trim().toLowerCase();
  const selectedModel = String(providerSettings?.model || '');
  const visionReady = screenshotSetting !== 'false'
    && modelCapabilities(providerSettings, provider, selectedModel).imageInput;
  const libreOfficeExecutable = await resolveLibreOfficeExecutable();
  const libreOfficePython = libreOfficeExecutable
    ? await resolveLibreOfficePythonExecutable(libreOfficeExecutable)
    : undefined;
  const libreOfficeWorker = await resolveUnoProgramWorker();
  const libreOfficeReady = Boolean(libreOfficeExecutable && libreOfficePython && libreOfficeWorker);
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
      detail: libreOfficeReady
        ? 'LibreOffice UNO 可用于 Office 创建、排版、预览与格式转换'
        : libreOfficeExecutable
          ? 'LibreOffice 已安装，但 Python/PyUNO Worker 不可用，Office 文件生成会受限'
          : '未找到 LibreOffice，Office 创建、预览与格式转换不可用',
      ready: libreOfficeReady,
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
