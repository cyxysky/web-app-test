'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TextArea } from '@heroui/react';
import Link from 'next/link';
import { ArrowLeft, FolderOpen, KeyRound, Loader2, PencilLine, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal';
import { SkillsManager } from '@/components/SkillsManager';
import {
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinitions,
  modelProviderDefinition,
  runtimeEnvDefinition,
  type SettingsTab,
} from '@/config/settings';
import { useI18n } from '@/i18n/I18nProvider';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { languageOptions } from '@/i18n/language';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { waitForMinimumLoading } from '@/lib/minimum-loading';
import type { ModelConfigRecord, ModelProvider, ModelProviderSettings, RuntimeEnvRecord } from '@/server/ai/schemas/runtime.schema';
import { useTheme } from '@/theme/ThemeProvider';
import { readApiJson } from '@/lib/api-client';
import { LoginAccountModal, type LoginAccountMetadata } from '@/components/LoginAccountModal';
import { DataTransferButtons } from '@/components/DataTransferButtons';
import { ManagementDataTable } from '@/components/ManagementDataTable';
import { AppInput } from '@/components/ui/app-input';
import { AppModal } from '@/components/ui/app-modal';
import { ColorPickerField } from '@/components/ui/color-picker-field';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import {
  environmentSettingsTabs,
  environmentSettingsTabsForUser,
} from '@/components/environment-settings-model';

export {
  environmentSettingsTabs,
  environmentSettingsTabsForUser,
  isAdministratorOnlySettingsTab,
} from '@/components/environment-settings-model';

export type EnvRow = Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'> & {
  hasValue?: boolean;
  updatedAt?: string;
};

export type ModelConfig = Pick<ModelConfigRecord, 'provider' | 'providers' | 'updatedAt'>;

export type EnvironmentSettingsInitialData = {
  envItems: EnvRow[];
  modelConfig: ModelConfig;
};

type PersonalMemoryScope = 'global' | 'domain';
type PersonalMemoryType = 'alias' | 'preference' | 'workflow' | 'domain_fact';
type PersonalMemoryStatus = 'active' | 'disabled';

type PersonalMemoryItem = {
  id: string;
  userId: string;
  shared: boolean;
  scope: PersonalMemoryScope;
  domain: string;
  type: PersonalMemoryType;
  key: string;
  aliases: string[];
  value: string;
  confidence: number;
  sourceSessionId?: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  status: PersonalMemoryStatus;
};

type PersonalMemoryDraft = {
  id?: string;
  userId?: string;
  shared: boolean;
  scope: PersonalMemoryScope;
  domain: string;
  type: PersonalMemoryType;
  key: string;
  aliasesText: string;
  value: string;
  status: PersonalMemoryStatus;
};

type PersonalMemoryEditorMode = 'create' | 'edit' | null;

type SystemBridge = {
  cancelDownload?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>;
  chooseDownloadDirectory?: (input?: { defaultPath?: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  downloadUrl?: (input: { defaultPath?: string; fileName?: string; url: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  getDownloads?: () => Promise<{ ok: boolean; directory?: string; downloads?: Array<{ completedAt?: number; error?: string; fileName?: string; id: string; path?: string; progress?: number; receivedBytes?: number; startedAt?: number; status?: string; totalBytes?: number; updatedAt?: number; url?: string }>; error?: string }>;
  onDownloadProgress?: (listener: (payload: { completedAt?: number; error?: string; fileName?: string; id: string; path?: string; progress?: number; receivedBytes?: number; startedAt?: number; status?: string; totalBytes?: number; updatedAt?: number; url?: string }) => void) => () => void;
  onDownloadRemoved?: (listener: (payload: { id: string }) => void) => () => void;
  openDownload?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>;
  readDownload?: (input: { id: string }) => Promise<{ ok: boolean; data?: ArrayBuffer; fileName?: string; error?: string }>;
  removeDownload?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>;
  selectDirectory: (input?: { defaultPath?: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  showDownloadInFolder?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>;
};

declare global {
  interface Window {
    webPilotSystem?: SystemBridge;
  }
}

const personalMemoryScopeOptions: Array<{ label: string; value: PersonalMemoryScope }> = [
  { label: '全局', value: 'global' },
  { label: '按域名', value: 'domain' },
];

const personalMemoryTypeOptions: Array<{ label: string; value: PersonalMemoryType }> = [
  { label: '短语别名', value: 'alias' },
  { label: '使用偏好', value: 'preference' },
  { label: '工作流程', value: 'workflow' },
  { label: '域名事实', value: 'domain_fact' },
];

function createPersonalMemoryDraft(): PersonalMemoryDraft {
  return {
    shared: false,
    scope: 'global',
    domain: '',
    type: 'alias',
    key: '',
    aliasesText: '',
    value: '',
    status: 'active',
  };
}

function personalMemoryDraftFromItem(item: PersonalMemoryItem): PersonalMemoryDraft {
  return {
    id: item.id,
    userId: item.userId,
    shared: item.shared,
    scope: item.scope,
    domain: item.domain || '',
    type: item.type,
    key: item.key,
    aliasesText: (item.aliases || []).join(', '),
    value: item.value,
    status: item.status,
  };
}

function personalMemoryAliasesFromText(value: string) {
  return value
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function personalMemoryTypeLabel(type: PersonalMemoryType) {
  return personalMemoryTypeOptions.find((option) => option.value === type)?.label || type;
}

function sortPersonalMemoryItems(items: PersonalMemoryItem[]) {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function personalMemoryItemApiPath(item: Pick<PersonalMemoryItem, 'id'>) {
  return withWebPilotBasePath(`/api/personal-memory/${encodeURIComponent(item.id)}`);
}

function personalMemoryDraftApiPath(draft: PersonalMemoryDraft) {
  if (!draft.id) return withWebPilotBasePath('/api/personal-memory');
  return withWebPilotBasePath(`/api/personal-memory/${encodeURIComponent(draft.id)}`);
}

function createModelConfig(input?: Partial<ModelConfig>): ModelConfig {
  const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const current = input?.providers?.[definition.value];
    const models = modelListForProvider(definition, current);
    const model = defaultModelForProvider(definition, { ...current, models });
    providers[definition.value] = {
      enabled: current?.enabled === true,
      defaultModel: model,
      model,
      models,
      apiKey: current?.apiKey || '',
      hasApiKey: Boolean(current?.hasApiKey || current?.apiKey),
      baseURL: current?.baseURL ?? definition.defaultBaseURL ?? '',
      updatedAt: current?.updatedAt,
    };
  }
  return {
    provider: input?.provider || 'openrouter',
    providers,
    updatedAt: input?.updatedAt || '',
  };
}

function providerSettings(config: ModelConfig, provider: ModelProvider) {
  const definition = modelProviderDefinition(provider);
  return config.providers[provider] || {
    enabled: false,
    defaultModel: definition.defaultModel,
    model: definition.defaultModel,
    models: modelListForProvider(definition),
    apiKey: '',
    baseURL: definition.defaultBaseURL || '',
  };
}

function draftModelRows(definition: ReturnType<typeof modelProviderDefinition>, settings: ModelProviderSettings) {
  const rows = Array.isArray(settings.models) && settings.models.length
    ? settings.models
    : [settings.defaultModel || settings.model || definition.defaultModel];
  return rows.length ? rows : [definition.defaultModel];
}

function isSecret(item: EnvRow) {
  return Boolean(item.secret || runtimeEnvDefinition(item.key)?.secret || /KEY|TOKEN|SECRET|PASSWORD|COOKIE|DATABASE_URL/i.test(item.key));
}

export function EnvironmentSettings({
  activeTab: controlledActiveTab,
  adminSettingsAccessToken = '',
  adminSettingsPasswordRequired = false,
  defaultUserId = '1',
  embedded = false,
  initialData,
  onActiveTabChange,
  onModelSaved,
  onRuntimeEnvSaved,
  onSkillsChanged,
  personalMemoryRefreshToken = '',
  showSectionTitles = true,
  showTabs = true,
  userId,
}: {
  activeTab?: SettingsTab;
  adminSettingsAccessToken?: string;
  adminSettingsPasswordRequired?: boolean;
  defaultUserId?: string;
  embedded?: boolean;
  initialData?: EnvironmentSettingsInitialData;
  onActiveTabChange?: (tab: SettingsTab) => void;
  onModelSaved?: () => void;
  onRuntimeEnvSaved?: () => void;
  onSkillsChanged?: () => void;
  personalMemoryRefreshToken?: string;
  showSectionTitles?: boolean;
  showTabs?: boolean;
  userId?: string;
} = {}) {
  const shouldLoadEnvironmentConfig = !controlledActiveTab
    || !['skills', 'memory', 'accounts'].includes(controlledActiveTab);
  const { language, setLanguage, t } = useI18n();
  const { color, scrollbarColor, setColor, setScrollbarColor } = useTheme();
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>('general');
  const [items, setItems] = useState<EnvRow[]>(() => initialData?.envItems || []);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(() => createModelConfig(initialData?.modelConfig));
  const [modelDraft, setModelDraft] = useState<ModelConfig>(() => createModelConfig(initialData?.modelConfig));
  const [personalMemoryItems, setPersonalMemoryItems] = useState<PersonalMemoryItem[]>([]);
  const [personalMemoryDraft, setPersonalMemoryDraft] = useState<PersonalMemoryDraft>(() => createPersonalMemoryDraft());
  const [personalMemoryEditorMode, setPersonalMemoryEditorMode] = useState<PersonalMemoryEditorMode>(null);
  const [loginAccounts, setLoginAccounts] = useState<LoginAccountMetadata[]>([]);
  const [loginAccountEditor, setLoginAccountEditor] = useState<LoginAccountMetadata | 'create' | null>(null);
  const [loadingLoginAccounts, setLoadingLoginAccounts] = useState(false);
  const loginAccountsLoadSequenceRef = useRef(0);
  const [deletingLoginAccountId, setDeletingLoginAccountId] = useState('');
  const [deleteLoginAccountTarget, setDeleteLoginAccountTarget] = useState<LoginAccountMetadata | null>(null);
  const [deleteLoginAccountError, setDeleteLoginAccountError] = useState('');
  const [loading, setLoading] = useState(!initialData && shouldLoadEnvironmentConfig && (!adminSettingsPasswordRequired || Boolean(adminSettingsAccessToken)));
  const [savingEnv, setSavingEnv] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [loadingPersonalMemory, setLoadingPersonalMemory] = useState(false);
  const personalMemoryLoadSequenceRef = useRef(0);
  const [savingPersonalMemory, setSavingPersonalMemory] = useState(false);
  const [updatingPersonalMemoryId, setUpdatingPersonalMemoryId] = useState('');
  const [deletingPersonalMemoryId, setDeletingPersonalMemoryId] = useState('');
  const [deletePersonalMemoryTarget, setDeletePersonalMemoryTarget] = useState<PersonalMemoryItem | null>(null);
  const [deletePersonalMemoryError, setDeletePersonalMemoryError] = useState('');
  const [hasDirectoryPicker, setHasDirectoryPicker] = useState(false);
  const normalizedDefaultUserId = defaultUserId.trim() || '1';
  const normalizedUserId = userId?.trim() || normalizedDefaultUserId;
  const visibleSettingsTabs = environmentSettingsTabsForUser(normalizedUserId, normalizedDefaultUserId);
  const requestedActiveTab = controlledActiveTab || internalActiveTab;
  const standaloneManagementTab = !showTabs && ['skills', 'memory', 'accounts'].includes(requestedActiveTab);
  const activeTab = standaloneManagementTab || visibleSettingsTabs.some((tab) => tab.id === requestedActiveTab) ? requestedActiveTab : 'general';
  const adminSettingsAuthorizationHeaders: Record<string, string> = adminSettingsAccessToken
    ? { Authorization: `Bearer ${adminSettingsAccessToken}` }
    : {};
  const selectTab = (tab: SettingsTab) => {
    if (!visibleSettingsTabs.some((item) => item.id === tab)) return;
    (onActiveTabChange || setInternalActiveTab)(tab);
  };

  function optionLabel(option: { label: string; value: string }) {
    if (option.label === '关闭' && option.value === 'false') return language === 'en' ? 'Off' : '关闭';
    return t(option.label);
  }

  useEffect(() => {
    setHasDirectoryPicker(typeof window !== 'undefined' && Boolean(window.webPilotSystem?.selectDirectory));
    if (!initialData && shouldLoadEnvironmentConfig && (!adminSettingsPasswordRequired || adminSettingsAccessToken)) void load();
    else setLoading(false);
  // The server snapshot is immutable for this component instance; saves update local state directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSettingsAccessToken, adminSettingsPasswordRequired]);

  async function load() {
    setLoading(true);
    try {
      const [envResponse, modelResponse] = await Promise.all([
        fetch(withWebPilotBasePath('/api/settings/env'), { cache: 'no-store', headers: adminSettingsAuthorizationHeaders }),
        fetch(withWebPilotBasePath('/api/settings/model'), { cache: 'no-store', headers: adminSettingsAuthorizationHeaders }),
      ]);
      const envData = await readApiJson<{ saved?: EnvRow[] }>(envResponse, t('读取环境配置失败'));
      const modelData = await readApiJson<{ config?: Partial<ModelConfig> }>(modelResponse, t('读取模型配置失败'));
      const nextModel = createModelConfig(modelData.config);
      setItems(envData.saved || []);
      setModelConfig(nextModel);
      setModelDraft(nextModel);
    } finally {
      setLoading(false);
    }
  }

  function update(index: number, patch: Partial<EnvRow>) {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, enabled: true, ...patch } : item)));
  }

  async function chooseRuntimeDirectory(index: number, item: EnvRow) {
    const bridge = typeof window !== 'undefined' ? window.webPilotSystem : undefined;
    if (!bridge?.selectDirectory) return;
    const result = await bridge.selectDirectory({ defaultPath: item.value || undefined });
    if (result.ok && result.path) {
      update(index, { value: result.path });
    } else if (!result.ok && result.error) {
      window.alert(t(result.error));
    }
  }

  async function saveEnv() {
    setSavingEnv(true);
    startGlobalLoading(t('正在保存环境配置'));
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/env'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminSettingsAuthorizationHeaders },
        body: JSON.stringify({ items: items.map((item) => ({ ...item, enabled: true, secret: isSecret(item) })) }),
      });
      const data = await readApiJson<{ saved?: EnvRow[] }>(response, t('保存环境配置失败'));
      setItems(data.saved || []);
      onRuntimeEnvSaved?.();
    } finally {
      setSavingEnv(false);
      stopGlobalLoading();
    }
  }

  function selectProvider(provider: ModelProvider) {
    setModelDraft((current) => ({
      ...createModelConfig(current),
      provider,
    }));
  }

  function updateActiveProviderSettings(patch: Partial<ModelProviderSettings>) {
    setModelDraft((current) => {
      const next = {
        ...current,
        providers: { ...current.providers },
      };
      const provider = next.provider;
      return {
        ...next,
        providers: {
          ...next.providers,
          [provider]: {
            ...providerSettings(next, provider),
            ...patch,
          },
        },
      };
    });
  }

  function setActiveProviderModels(models: string[], defaultModel?: string) {
    setModelDraft((current) => {
      const next = {
        ...current,
        providers: { ...current.providers },
      };
      const provider = next.provider;
      const definition = modelProviderDefinition(provider);
      const currentSettings = providerSettings(next, provider);
      const fallbackModel = defaultModel || currentSettings.defaultModel || currentSettings.model || definition.defaultModel;
      return {
        ...next,
        providers: {
          ...next.providers,
          [provider]: {
            ...currentSettings,
            defaultModel: fallbackModel,
            model: fallbackModel,
            models,
          },
        },
      };
    });
  }

  function updateActiveProviderModel(index: number, value: string) {
    const rows = [...draftModelRows(activeProviderOption, activeProviderSettings)];
    const previous = rows[index];
    rows[index] = value;
    const trimmedRows = rows.map((item) => item.trim()).filter(Boolean);
    const currentDefault = activeProviderSettings.defaultModel || activeProviderSettings.model || activeProviderOption.defaultModel;
    const nextDefault = previous === currentDefault || !trimmedRows.includes(currentDefault)
      ? value.trim() || trimmedRows[0] || activeProviderOption.defaultModel
      : currentDefault;
    setActiveProviderModels(rows, nextDefault);
  }

  function addActiveProviderModel() {
    setActiveProviderModels([...draftModelRows(activeProviderOption, activeProviderSettings), ''], activeProviderSettings.defaultModel || activeProviderSettings.model);
  }

  function removeActiveProviderModel(index: number) {
    const rows = draftModelRows(activeProviderOption, activeProviderSettings);
    if (rows.length <= 1) return;
    const removed = rows[index];
    const nextRows = rows.filter((_, itemIndex) => itemIndex !== index);
    const remaining = nextRows.map((item) => item.trim()).filter(Boolean);
    const currentDefault = activeProviderSettings.defaultModel || activeProviderSettings.model || activeProviderOption.defaultModel;
    const nextDefault = removed === currentDefault || !remaining.includes(currentDefault)
      ? remaining[0] || activeProviderOption.defaultModel
      : currentDefault;
    setActiveProviderModels(nextRows, nextDefault);
  }

  async function saveModel() {
    const payload = createModelConfig(modelDraft || modelConfig);
    setSavingModel(true);
    startGlobalLoading(t('正在保存模型配置'));
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminSettingsAuthorizationHeaders },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<{ config?: Partial<ModelConfig> }>(response, t('保存模型配置失败'));
      const nextModel = createModelConfig(data.config);
      setModelConfig(nextModel);
      setModelDraft(nextModel);
      onModelSaved?.();
    } finally {
      setSavingModel(false);
      stopGlobalLoading();
    }
  }

  async function reloadModelConfigAfterImport() {
    const response = await fetch(withWebPilotBasePath('/api/settings/model'), {
      cache: 'no-store',
      headers: adminSettingsAuthorizationHeaders,
    });
    const data = await readApiJson<{ config?: Partial<ModelConfig> }>(response, t('读取模型配置失败'));
    const nextModel = createModelConfig(data.config);
    setModelConfig(nextModel);
    setModelDraft(nextModel);
    onModelSaved?.();
  }

  function updatePersonalMemoryDraft(patch: Partial<PersonalMemoryDraft>) {
    setPersonalMemoryDraft((current) => {
      const next = { ...current, ...patch };
      if (patch.scope === 'global') next.domain = '';
      return next;
    });
  }

  function resetPersonalMemoryDraft() {
    setPersonalMemoryDraft(createPersonalMemoryDraft());
  }

  function openCreatePersonalMemory() {
    setPersonalMemoryDraft(createPersonalMemoryDraft());
    setPersonalMemoryEditorMode('create');
  }

  function openEditPersonalMemory(item: PersonalMemoryItem) {
    if (item.userId !== normalizedUserId) return;
    setPersonalMemoryDraft(personalMemoryDraftFromItem(item));
    setPersonalMemoryEditorMode('edit');
  }

  function closePersonalMemoryEditor() {
    if (savingPersonalMemory) return;
    setPersonalMemoryEditorMode(null);
    resetPersonalMemoryDraft();
  }

  function replacePersonalMemoryItem(item: PersonalMemoryItem) {
    setPersonalMemoryItems((current) => sortPersonalMemoryItems([item, ...current.filter((entry) => entry.id !== item.id)]));
  }

  function replacePersonalMemoryItemInPlace(item: PersonalMemoryItem) {
    setPersonalMemoryItems((current) => current.map((entry) => entry.id === item.id ? item : entry));
  }

  const loadPersonalMemoryItems = useCallback(async () => {
    const loadingSequence = ++personalMemoryLoadSequenceRef.current;
    const loadingStartedAt = Date.now();
    setLoadingPersonalMemory(true);
    try {
      const response = await fetch(withWebPilotBasePath('/api/personal-memory?includeDisabled=true'), { cache: 'no-store' });
      const data = await readApiJson<{ items?: PersonalMemoryItem[] }>(response, t('读取个性化记忆失败'));
      setPersonalMemoryItems(sortPersonalMemoryItems(Array.isArray(data.items) ? data.items : []));
    } finally {
      await waitForMinimumLoading(loadingStartedAt);
      if (personalMemoryLoadSequenceRef.current === loadingSequence) setLoadingPersonalMemory(false);
    }
  }, [t]);

  useLayoutEffect(() => {
    if (activeTab !== 'memory') return;
    void loadPersonalMemoryItems().catch(() => undefined);
  }, [activeTab, loadPersonalMemoryItems, personalMemoryRefreshToken]);

  const loadLoginAccounts = useCallback(async () => {
    const loadingSequence = ++loginAccountsLoadSequenceRef.current;
    const loadingStartedAt = Date.now();
    setLoadingLoginAccounts(true);
    try {
      const response = await fetch(withWebPilotBasePath('/api/login-accounts'), { cache: 'no-store' });
      const data = await readApiJson<{ accounts?: LoginAccountMetadata[] }>(response, t('读取登录账号失败'));
      setLoginAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } finally {
      await waitForMinimumLoading(loadingStartedAt);
      if (loginAccountsLoadSequenceRef.current === loadingSequence) setLoadingLoginAccounts(false);
    }
  }, [t]);

  useLayoutEffect(() => {
    if (activeTab !== 'accounts') return;
    void loadLoginAccounts().catch(() => undefined);
  }, [activeTab, loadLoginAccounts]);

  function replaceLoginAccount(account: LoginAccountMetadata) {
    setLoginAccounts((current) => [account, ...current.filter((item) => item.id !== account.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  function requestDeleteLoginAccount(account: LoginAccountMetadata) {
    if (account.userId !== normalizedUserId) return;
    setDeleteLoginAccountTarget(account);
    setDeleteLoginAccountError('');
  }

  function closeDeleteLoginAccountModal() {
    if (deletingLoginAccountId) return;
    setDeleteLoginAccountTarget(null);
    setDeleteLoginAccountError('');
  }

  async function confirmDeleteLoginAccount() {
    const account = deleteLoginAccountTarget;
    if (!account) return;
    setDeletingLoginAccountId(account.id);
    setDeleteLoginAccountError('');
    startGlobalLoading(t('正在删除登录账号'));
    try {
      const response = await fetch(withWebPilotBasePath(`/api/login-accounts/${encodeURIComponent(account.id)}`), { method: 'DELETE' });
      await readApiJson(response, t('删除登录账号失败'));
      setLoginAccounts((current) => current.filter((item) => item.id !== account.id));
      setDeleteLoginAccountTarget(null);
    } catch (error) {
      setDeleteLoginAccountError(error instanceof Error ? t(error.message) : t('删除登录账号失败'));
    } finally {
      setDeletingLoginAccountId('');
      stopGlobalLoading();
    }
  }

  function personalMemoryPayload() {
    return {
      shared: personalMemoryDraft.shared,
      scope: personalMemoryDraft.scope,
      domain: personalMemoryDraft.scope === 'domain' ? personalMemoryDraft.domain.trim() : '',
      type: personalMemoryDraft.type,
      key: personalMemoryDraft.key.trim(),
      aliases: personalMemoryAliasesFromText(personalMemoryDraft.aliasesText),
      value: personalMemoryDraft.value.trim(),
      status: personalMemoryDraft.status,
      confidence: 0.9,
    };
  }

  async function savePersonalMemory() {
    const payload = personalMemoryPayload();
    if (!payload.key || !payload.value) {
      window.alert(t('记忆需要填写短语和说明'));
      return;
    }
    if (payload.scope === 'domain' && !payload.domain) {
      window.alert(t('域名记忆需要填写域名'));
      return;
    }
    setSavingPersonalMemory(true);
    startGlobalLoading(t(personalMemoryDraft.id ? '正在保存记忆' : '正在新增记忆'));
    try {
      const response = await fetch(personalMemoryDraftApiPath(personalMemoryDraft), {
        method: personalMemoryDraft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<{ item?: PersonalMemoryItem }>(response, t('保存个性化记忆失败'));
      if (data.item) replacePersonalMemoryItem(data.item);
      setPersonalMemoryEditorMode(null);
      resetPersonalMemoryDraft();
    } finally {
      setSavingPersonalMemory(false);
      stopGlobalLoading();
    }
  }

  async function togglePersonalMemory(item: PersonalMemoryItem) {
    if (item.userId !== normalizedUserId) return;
    setUpdatingPersonalMemoryId(item.id);
    try {
      const response = await fetch(personalMemoryItemApiPath(item), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: item.status === 'active' ? 'disabled' : 'active' }),
      });
      const data = await readApiJson<{ item?: PersonalMemoryItem }>(response, t('更新个性化记忆失败'));
      if (data.item) replacePersonalMemoryItemInPlace(data.item);
    } finally {
      setUpdatingPersonalMemoryId('');
    }
  }

  function requestDeletePersonalMemory(item: PersonalMemoryItem) {
    if (item.userId !== normalizedUserId) return;
    setDeletePersonalMemoryTarget(item);
    setDeletePersonalMemoryError('');
  }

  function closeDeletePersonalMemoryModal() {
    if (deletingPersonalMemoryId) return;
    setDeletePersonalMemoryTarget(null);
    setDeletePersonalMemoryError('');
  }

  async function confirmDeletePersonalMemory() {
    const item = deletePersonalMemoryTarget;
    if (!item) return;
    setDeletingPersonalMemoryId(item.id);
    setDeletePersonalMemoryError('');
    startGlobalLoading(t('正在删除记忆'));
    try {
      const response = await fetch(personalMemoryItemApiPath(item), { method: 'DELETE' });
      await readApiJson(response, t('删除个性化记忆失败'));
      setPersonalMemoryItems((current) => current.filter((entry) => entry.id !== item.id));
      if (personalMemoryDraft.id === item.id) closePersonalMemoryEditor();
      setDeletePersonalMemoryTarget(null);
    } catch (error) {
      setDeletePersonalMemoryError(error instanceof Error ? t(error.message) : t('删除个性化记忆失败'));
    } finally {
      setDeletingPersonalMemoryId('');
      stopGlobalLoading();
    }
  }

  function renderRuntimeControl(item: EnvRow, index: number) {
    const definition = runtimeEnvDefinition(item.key);
    if (definition?.control === 'boolean') {
      const checked = item.value === 'true';
      return (
        <button className={`settings-toggle${checked ? ' on' : ''}`} onClick={() => update(index, { value: checked ? 'false' : 'true' })} type="button" aria-pressed={checked}>
          <span />
        </button>
      );
    }

    if (definition?.control === 'select') {
      return (
        <CustomSelect
          className="settings-control"
          value={item.value}
          onChange={(nextValue) => update(index, { value: nextValue })}
          options={(definition.options || []).map((option) => ({
            label: optionLabel(option),
            value: option.value,
          }))}
        />
      );
    }

    if (definition?.control === 'textarea') {
      return (
        <div className="settings-prompt-control">
          <TextArea
            fullWidth
            placeholder={t('未设置')}
            value={item.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
        </div>
      );
    }

    if (definition?.picker === 'directory') {
      return (
        <div className="settings-directory-control">
          <AppInput
            placeholder={t('未设置')}
            type="text"
            value={item.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            className="ui-button ui-button--neutral"
            disabled={!hasDirectoryPicker}
            onClick={() => chooseRuntimeDirectory(index, item)}
            title={hasDirectoryPicker ? t('选择目录') : t('仅 Electron 桌面端支持目录选择')}
            type="button"
          >
            <FolderOpen size={15} />
            {t('选择')}
          </button>
        </div>
      );
    }

    return (
      <AppInput
        inputMode={definition?.control === 'number' ? 'decimal' : undefined}
        min={definition?.min}
        max={definition?.max}
        placeholder={item.hasValue ? t('已配置，留空表示不修改') : t('未设置')}
        type={definition?.control === 'number' ? 'number' : isSecret(item) ? 'password' : 'text'}
        step={definition?.step}
        value={item.value}
        onChange={(event) => update(index, { value: event.target.value })}
      />
    );
  }

  function renderPersonalMemoryEditorModal() {
    if (!personalMemoryEditorMode) return null;
    const editing = personalMemoryEditorMode === 'edit';
    return (
      <AppModal
        ariaLabelledBy="personal-memory-modal-title"
        dismissable={!savingPersonalMemory}
        keyboardDismissable={!savingPersonalMemory}
        onClose={closePersonalMemoryEditor}
        size="wide"
      >
          <header className="ui-modal-header">
            <div className="ui-modal-heading">
              <h2 className="ui-modal-title" id="personal-memory-modal-title">{t(editing ? '编辑记忆' : '新增记忆')}</h2>
              <p className="ui-modal-subtitle">{editing ? personalMemoryDraft.id : t('保存后即可在后续对话中召回')}</p>
            </div>
            <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" disabled={savingPersonalMemory} onClick={closePersonalMemoryEditor} type="button">
              <X size={16} />
            </button>
          </header>

          <div className="ui-modal-body personal-memory-form">
            <label className="personal-memory-field">
              <span>{t('范围')}</span>
              <CustomSelect
                className="settings-control"
                value={personalMemoryDraft.scope}
                onChange={(value) => updatePersonalMemoryDraft({ scope: value as PersonalMemoryScope })}
                options={personalMemoryScopeOptions.map((option) => ({ label: t(option.label), value: option.value }))}
              />
            </label>
            <label className="personal-memory-field">
              <span>{t('域名')}</span>
              <AppInput
                disabled={personalMemoryDraft.scope !== 'domain'}
                placeholder="jira.company.local"
                value={personalMemoryDraft.domain}
                onChange={(event) => updatePersonalMemoryDraft({ domain: event.target.value })}
              />
            </label>
            <label className="personal-memory-field">
              <span>{t('类型')}</span>
              <CustomSelect
                className="settings-control"
                value={personalMemoryDraft.type}
                onChange={(value) => updatePersonalMemoryDraft({ type: value as PersonalMemoryType })}
                options={personalMemoryTypeOptions.map((option) => ({ label: t(option.label), value: option.value }))}
              />
            </label>
            <div className="personal-memory-field personal-memory-status-field">
              <span>{t('状态')}</span>
              <div className="personal-memory-status-control">
                <button
                  aria-label={personalMemoryDraft.status === 'active' ? t('禁用记忆') : t('启用记忆')}
                  aria-pressed={personalMemoryDraft.status === 'active'}
                  className={`settings-toggle${personalMemoryDraft.status === 'active' ? ' on' : ''}`}
                  disabled={savingPersonalMemory}
                  onClick={() => updatePersonalMemoryDraft({ status: personalMemoryDraft.status === 'active' ? 'disabled' : 'active' })}
                  type="button"
                >
                  <span />
                </button>
                <span className="personal-memory-status-label">{t(personalMemoryDraft.status === 'active' ? '启用' : '禁用')}</span>
              </div>
            </div>
            <label className="personal-memory-field">
              <span>{t('常用短语')}</span>
              <AppInput
                placeholder="jira"
                value={personalMemoryDraft.key}
                onChange={(event) => updatePersonalMemoryDraft({ key: event.target.value })}
              />
            </label>
            <label className="personal-memory-field">
              <span>{t('等价说法')}</span>
              <AppInput
                placeholder={t('逗号或换行分隔')}
                value={personalMemoryDraft.aliasesText}
                onChange={(event) => updatePersonalMemoryDraft({ aliasesText: event.target.value })}
              />
            </label>
            <label className="personal-memory-field wide">
              <span>{t('说明')}</span>
              <TextArea
                fullWidth
                placeholder={t('公司私域 Jira，地址是 ...')}
                value={personalMemoryDraft.value}
                onChange={(event) => updatePersonalMemoryDraft({ value: event.target.value })}
              />
            </label>
            <div className="resource-sharing-field wide">
              <div>
                <strong>{t('所有 ID 共享')}</strong>
                <small>{t('其他 ID 可以使用此记忆，但只有创建 ID {id} 可以编辑或删除', { id: personalMemoryDraft.userId || normalizedUserId })}</small>
              </div>
              <button
                aria-pressed={personalMemoryDraft.shared}
                className={`settings-toggle${personalMemoryDraft.shared ? ' on' : ''}`}
                disabled={savingPersonalMemory}
                onClick={() => updatePersonalMemoryDraft({ shared: !personalMemoryDraft.shared })}
                type="button"
              >
                <span />
              </button>
            </div>
          </div>

          <footer className="ui-modal-footer">
            <button className="ui-button ui-button--neutral" disabled={savingPersonalMemory} onClick={closePersonalMemoryEditor} type="button">
              <X size={15} />
              {t('取消')}
            </button>
            <button className="ui-button ui-button--primary" disabled={savingPersonalMemory} onClick={() => void savePersonalMemory()} type="button">
              {savingPersonalMemory ? <Loader2 className="spin" size={15} /> : editing ? <Save size={15} /> : <Plus size={15} />}
              {t(editing ? '保存记忆' : '新增记忆')}
            </button>
          </footer>
      </AppModal>
    );
  }

  function renderDeletePersonalMemoryModal() {
    if (!deletePersonalMemoryTarget) return null;
    const deleting = deletingPersonalMemoryId === deletePersonalMemoryTarget.id;
    return (
      <ConfirmDeleteModal
        deleting={deleting}
        description={t('确认删除这条记忆？')}
        error={deletePersonalMemoryError}
        id="personal-memory-delete-title"
        itemTitle={deletePersonalMemoryTarget.key}
        onClose={closeDeletePersonalMemoryModal}
        onConfirm={confirmDeletePersonalMemory}
        title={t('删除记忆')}
      />
    );
  }

  function renderDeleteLoginAccountModal() {
    if (!deleteLoginAccountTarget) return null;
    const deleting = deletingLoginAccountId === deleteLoginAccountTarget.id;
    return (
      <ConfirmDeleteModal
        deleting={deleting}
        description={t('确认删除这个登录账号？')}
        error={deleteLoginAccountError}
        id="login-account-delete-title"
        itemTitle={deleteLoginAccountTarget.label || deleteLoginAccountTarget.username}
        onClose={closeDeleteLoginAccountModal}
        onConfirm={confirmDeleteLoginAccount}
        title={t('删除登录账号')}
      />
    );
  }

  function renderPersonalMemoryPanel() {
    const memoryActions = (
      <div className="personal-memory-head-actions">
        <DataTransferButtons kind="memory" onImported={loadPersonalMemoryItems} />
        <button className="ui-button ui-button--neutral" disabled={loadingPersonalMemory} onClick={() => void loadPersonalMemoryItems()} type="button">
          <RefreshCw size={15} />
          {t('刷新')}
        </button>
        <button className="ui-button ui-button--primary" onClick={openCreatePersonalMemory} type="button">
          <Plus size={15} />
          {t('新增记忆')}
        </button>
      </div>
    );
    return (
      <section className={loadingPersonalMemory ? 'personal-memory-settings is-loading' : 'personal-memory-settings'}>
        {showSectionTitles ? <div className="settings-section-head">
          <div>
            <h2>{t('个性化记忆')}</h2>
            <span>{t('{count} 条记录，存储于本地数据库', { count: personalMemoryItems.length })}</span>
          </div>
          {memoryActions}
        </div> : null}

        {loadingPersonalMemory ? (
          <div className="settings-loading-panel compact" role="status" aria-live="polite" aria-label={t('正在读取个性化记忆')}>
            <LiquidGlassLoader className="ui-liquid-glass-loader--compact" />
            <div>
              <h2>{t('正在读取个性化记忆')}</h2>
            </div>
          </div>
        ) : (
          <ManagementDataTable
            columns={[
              {
                key: 'memory',
                label: t('记忆'),
                className: 'management-table-primary-column',
                filter: {
                  getValue: (item) => [item.key, item.value, ...(item.aliases || [])],
                  type: 'text',
                },
                render: (item) => (
                  <div className="management-table-primary-copy">
                    <strong>{item.key}</strong>
                    <span>{item.value}</span>
                    {item.aliases?.length ? <small>{t('等价说法')}：{item.aliases.join(' · ')}</small> : null}
                  </div>
                ),
              },
              {
                key: 'type',
                label: t('类型'),
                filter: {
                  getValue: (item) => item.type,
                  options: personalMemoryTypeOptions.map((option) => ({ label: t(option.label), value: option.value })),
                  type: 'select',
                },
                render: (item) => <span>{t(personalMemoryTypeLabel(item.type))}</span>,
              },
              {
                key: 'scope',
                label: t('适用范围'),
                filter: {
                  getValue: (item) => item.scope,
                  options: personalMemoryScopeOptions.map((option) => ({ label: t(option.label), value: option.value })),
                  type: 'select',
                },
                render: (item) => (
                  <div className="management-table-cell-stack">
                    <span>{item.scope === 'domain' ? item.domain : t('全局')}</span>
                    <small>{item.shared ? t('所有 ID 共享') : t('仅创建 ID')}</small>
                  </div>
                ),
              },
              {
                key: 'status',
                label: t('状态'),
                className: 'personal-memory-status-column',
                filter: {
                  getValue: (item) => item.status,
                  options: [
                    { label: t('启用'), value: 'active' },
                    { label: t('禁用'), value: 'disabled' },
                  ],
                  type: 'select',
                },
                render: (item) => (
                  <div className="personal-memory-status-cell">
                    <div className="personal-memory-status-control">
                      <button
                        aria-label={item.status === 'active' ? t('禁用记忆') : t('启用记忆')}
                        aria-pressed={item.status === 'active'}
                        className={`settings-toggle settings-toggle--status${item.status === 'active' ? ' on' : ''}${updatingPersonalMemoryId === item.id ? ' is-loading' : ''}`}
                        disabled={item.userId !== normalizedUserId || updatingPersonalMemoryId === item.id || deletingPersonalMemoryId === item.id}
                        onClick={() => void togglePersonalMemory(item)}
                        title={item.status === 'active' ? t('禁用记忆') : t('启用记忆')}
                        type="button"
                      >
                        <span>{updatingPersonalMemoryId === item.id ? <Loader2 className="spin" size={12} /> : null}</span>
                      </button>
                      <span className="personal-memory-status-label">{t(item.status === 'active' ? '启用' : '禁用')}</span>
                    </div>
                  </div>
                ),
              },
              {
                key: 'updated',
                label: t('最近更新'),
                className: 'management-table-date-column',
                filter: { getValue: (item) => item.updatedAt, type: 'datetime' },
                render: (item) => <span className="management-table-muted">{new Date(item.updatedAt).toLocaleString()}</span>,
              },
              {
                key: 'actions',
                label: t('操作'),
                className: 'management-table-actions-column',
                render: (item) => (
                  <div className="personal-memory-actions">
                    {item.userId === normalizedUserId ? <>
                      <button
                        aria-label={t('编辑记忆')}
                        className="settings-model-row-button"
                        disabled={savingPersonalMemory || updatingPersonalMemoryId === item.id || deletingPersonalMemoryId === item.id}
                        onClick={() => openEditPersonalMemory(item)}
                        title={t('编辑记忆')}
                        type="button"
                      >
                        <PencilLine size={15} />
                      </button>
                      <button
                        aria-label={t('删除记忆')}
                        className="settings-model-row-button danger"
                        disabled={deletingPersonalMemoryId === item.id}
                        onClick={() => requestDeletePersonalMemory(item)}
                        title={t('删除记忆')}
                        type="button"
                      >
                        {deletingPersonalMemoryId === item.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                      </button>
                    </> : <span className="resource-readonly-label">{t('只读')}</span>}
                  </div>
                ),
              },
            ]}
            emptyText={t('暂无个性化记忆')}
            getId={(item) => item.id}
            getSearchText={(item) => [
              item.key,
              item.value,
              item.domain,
              item.type,
              item.status,
              personalMemoryTypeLabel(item.type),
              t(item.status === 'active' ? '启用' : '禁用'),
              item.shared ? t('所有 ID 共享') : t('仅创建 ID'),
              item.userId,
              ...(item.aliases || []),
            ]}
            items={personalMemoryItems}
            rowClassName={(item) => item.status === 'disabled' ? 'is-disabled' : ''}
            searchPlaceholder={t('筛选记忆')}
            toolbarActions={showSectionTitles ? undefined : memoryActions}
          />
        )}
        {renderPersonalMemoryEditorModal()}
        {renderDeletePersonalMemoryModal()}
      </section>
    );
  }

  function renderLoginAccountsPanel() {
    const accountActions = (
      <div className="personal-memory-head-actions">
        <DataTransferButtons kind="credentials" onImported={loadLoginAccounts} />
        <button className="ui-button ui-button--neutral" disabled={loadingLoginAccounts} onClick={() => void loadLoginAccounts()} type="button">
          <RefreshCw size={15} />
          {t('刷新')}
        </button>
        <button className="ui-button ui-button--primary" onClick={() => setLoginAccountEditor('create')} type="button">
          <Plus size={15} />
          {t('新增账号')}
        </button>
      </div>
    );
    return (
      <section className={loadingLoginAccounts ? 'login-account-settings is-loading' : 'login-account-settings'}>
        {showSectionTitles ? <div className="settings-section-head">
          <div>
            <h2>{t('登录账号')}</h2>
            <span>{t('{count} 个按域名保存的账号；密码只在后台解密并通过短期安全引用使用', { count: loginAccounts.length })}</span>
          </div>
          {accountActions}
        </div> : null}

        {loadingLoginAccounts ? (
          <div className="settings-loading-panel compact" role="status" aria-live="polite" aria-label={t('正在读取登录账号')}>
            <LiquidGlassLoader className="ui-liquid-glass-loader--compact" />
            <div><h2>{t('正在读取登录账号')}</h2></div>
          </div>
        ) : (
          <ManagementDataTable
            columns={[
              {
                key: 'account',
                label: t('账号'),
                className: 'management-table-primary-column',
                filter: { getValue: (account) => [account.label, account.username], type: 'text' },
                render: (account) => (
                  <div className="management-table-account-copy">
                    <span className="login-account-item-icon" aria-hidden="true"><KeyRound size={16} /></span>
                    <span>
                      <strong>{account.label || account.username}</strong>
                      <small>{account.username}</small>
                    </span>
                  </div>
                ),
              },
              {
                key: 'domain',
                label: t('域名'),
                filter: { getValue: (account) => [account.domain, account.loginUrl || ''], type: 'text' },
                render: (account) => <span>{account.domain}</span>,
              },
              {
                key: 'scope',
                label: t('共享范围'),
                filter: {
                  getValue: (account) => account.shared ? 'shared' : 'private',
                  options: [
                    { label: t('所有 ID 共享'), value: 'shared' },
                    { label: t('仅创建 ID'), value: 'private' },
                  ],
                  type: 'select',
                },
                render: (account) => (
                  <span className="management-table-muted">
                    {account.shared
                      ? account.userId === normalizedUserId ? t('所有 ID 共享') : t('由 ID {id} 共享', { id: account.userId })
                      : t('仅创建 ID')}
                  </span>
                ),
              },
              {
                key: 'status',
                label: t('状态'),
                filter: {
                  getValue: (account) => account.status,
                  options: [
                    { label: t('可用于目标测试'), value: 'active' },
                    { label: t('已停用'), value: 'disabled' },
                  ],
                  type: 'select',
                },
                render: (account) => (
                  <div className="management-table-cell-stack">
                    <span>{t(account.status === 'active' ? '可用于目标测试' : '已停用')}</span>
                  </div>
                ),
              },
              {
                key: 'updated',
                label: t('最近更新'),
                className: 'management-table-date-column',
                filter: { getValue: (account) => account.updatedAt, type: 'datetime' },
                render: (account) => <span className="management-table-muted">{new Date(account.updatedAt).toLocaleString()}</span>,
              },
              {
                key: 'actions',
                label: t('操作'),
                className: 'management-table-actions-column',
                render: (account) => (
                  <div className="login-account-item-actions">
                    {account.userId === normalizedUserId ? <>
                      <button aria-label={t('编辑登录账号')} className="settings-model-row-button" onClick={() => setLoginAccountEditor(account)} title={t('编辑登录账号')} type="button">
                        <PencilLine size={15} />
                      </button>
                      <button
                        aria-label={t('删除登录账号')}
                        className="settings-model-row-button danger"
                        disabled={deletingLoginAccountId === account.id}
                        onClick={() => requestDeleteLoginAccount(account)}
                        title={t('删除登录账号')}
                        type="button"
                      >
                        {deletingLoginAccountId === account.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                      </button>
                    </> : <span className="resource-readonly-label">{t('只读')}</span>}
                  </div>
                ),
              },
            ]}
            emptyText={t('尚未保存登录账号。目标测试需要新账号时，也可以直接在目标卡片中创建。')}
            getId={(account) => account.id}
            getSearchText={(account) => [
              account.label,
              account.username,
              account.domain,
              account.loginUrl || '',
              account.status,
              t(account.status === 'active' ? '可用于目标测试' : '已停用'),
              account.shared ? t('所有 ID 共享') : t('仅创建 ID'),
              account.userId,
            ]}
            items={loginAccounts}
            rowClassName={(account) => account.status === 'disabled' ? 'is-disabled' : ''}
            searchPlaceholder={t('筛选登录账号')}
            toolbarActions={showSectionTitles ? undefined : accountActions}
          />
        )}

        <LoginAccountModal
          account={loginAccountEditor && loginAccountEditor !== 'create' ? loginAccountEditor : undefined}
          onClose={() => setLoginAccountEditor(null)}
          onSaved={replaceLoginAccount}
          open={Boolean(loginAccountEditor)}
        />
        {renderDeleteLoginAccountModal()}
      </section>
    );
  }

  const editingModelConfig = modelDraft || modelConfig;
  const activeProvider = editingModelConfig.provider;
  const activeProviderOption = modelProviderDefinition(activeProvider);
  const activeProviderSettings = providerSettings(editingModelConfig, activeProvider);
  const activeProviderModels = draftModelRows(activeProviderOption, activeProviderSettings);
  const activeProviderDefaultModel = activeProviderSettings.defaultModel || activeProviderSettings.model || activeProviderOption.defaultModel;
  const activeProviderEnabled = activeProviderSettings.enabled === true;
  const visibleEnvItems = items
    .map((item, index) => ({ item, index, definition: runtimeEnvDefinition(item.key) }))
    .filter(({ definition }) => activeTab !== 'general' && activeTab !== 'model' && activeTab !== 'skills' && activeTab !== 'memory' && activeTab !== 'accounts' && definition?.tab === activeTab);

  return (
    <main className={embedded ? 'settings-workspace embedded' : 'settings-workspace'}>
      {embedded ? null : (
        <header className="settings-header">
          <Link className="ghost-link" href="/dashboard">
            <ArrowLeft size={15} />
            {t('返回工作台')}
          </Link>
          <div>
            <h1>{t('环境配置')}</h1>
            <span>{t('模型、浏览器、运行控制和调试参数全部在网页配置中管理。')}</span>
          </div>
        </header>
      )}

      <div className={showTabs ? 'settings-layout' : 'settings-layout no-tabs'}>
        {showTabs ? (
          <nav className="settings-tabs" aria-label={t('环境配置分类')}>
            {visibleSettingsTabs.map((tab) => (
              <button className={activeTab === tab.id ? 'active' : undefined} key={tab.id} onClick={() => selectTab(tab.id)} type="button">
                {t(tab.label)}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="settings-content">
          {loading ? (
            <section className="settings-loading-panel" role="status" aria-live="polite">
              <LiquidGlassLoader />
              <div>
                <h2>{t('正在读取环境配置')}</h2>
                <span>{t('正在加载模型、浏览器、运行控制和调试参数。')}</span>
              </div>
            </section>
          ) : (
            <>
          {activeTab === 'general' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>{t('通用设置')}</h2>
                  <span>{t('选择界面显示语言。')}</span>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-row">
                  <div>
                    <strong>{t('界面语言')}</strong>
                    <span>{t('选择界面显示语言。')}</span>
                  </div>
                  <CustomSelect
                    className="settings-control"
                    value={language}
                    onChange={(nextValue) => setLanguage(nextValue === 'en' ? 'en' : 'zh')}
                    options={languageOptions.map((option) => ({
                      label: t(option.label),
                      value: option.value,
                    }))}
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{t('主题色')}</strong>
                    <span>{t('调整按钮、滚动条和高亮状态使用的主题色。')}</span>
                  </div>
                  <div className="theme-color-picker">
                    <ColorPickerField
                      ariaLabel={t('主题色')}
                      onChange={setColor}
                      value={color}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{t('滚动条滑块颜色')}</strong>
                    <span>{t('自定义全局滚动条滑块颜色。')}</span>
                  </div>
                  <div className="theme-color-picker">
                    <ColorPickerField
                      ariaLabel={t('滚动条滑块颜色')}
                      onChange={setScrollbarColor}
                      value={scrollbarColor}
                    />
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {activeTab === 'model' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>{t('模型配置')}</h2>
                  <span>{t('每个服务商独立保存模型、Key 和 Base URL，切换服务商不会串用密钥。')}</span>
                </div>
                <div className="personal-memory-head-actions">
                  <DataTransferButtons
                    authorizationToken={adminSettingsAccessToken}
                    disabled={savingModel || loading}
                    kind="model"
                    onImported={reloadModelConfigAfterImport}
                  />
                  <button className="ui-button ui-button--primary" disabled={savingModel || loading} onClick={saveModel} type="button">
                    {savingModel ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                    {t('保存')}
                  </button>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-row">
                  <div>
                    <strong>{t('默认服务商')}</strong>
                    <span>{t('选择默认使用的 AI 模型服务提供商。')}</span>
                  </div>
                  <CustomSelect
                    className="settings-control"
                    value={activeProvider}
                    onChange={(nextValue) => selectProvider(nextValue as ModelProvider)}
                    options={modelProviderDefinitions.map((provider) => ({
                      label: t(provider.label),
                      value: provider.value,
                    }))}
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{t('启用服务商')}</strong>
                    <span>{t('开启后，该服务商下配置的模型才会出现在模型选择列表中。')}</span>
                  </div>
                  <button
                    aria-label={t(activeProviderEnabled ? '关闭当前服务商' : '开启当前服务商')}
                    aria-pressed={activeProviderEnabled}
                    className={`settings-toggle${activeProviderEnabled ? ' on' : ''}`}
                    onClick={() => updateActiveProviderSettings({ enabled: !activeProviderEnabled })}
                    title={t(activeProviderEnabled ? '已开启' : '已关闭')}
                    type="button"
                  >
                    <span />
                  </button>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{t('默认模型')}</strong>
                    <span>{t('从当前服务商配置的模型列表中选择默认模型。')}</span>
                  </div>
                  <CustomSelect
                    className="settings-control"
                    disabled={!activeProviderEnabled}
                    value={activeProviderDefaultModel}
                    onChange={(nextModel) => updateActiveProviderSettings({ defaultModel: nextModel, model: nextModel })}
                    options={modelListForProvider(activeProviderOption, activeProviderSettings).map((model) => ({
                      label: model,
                      value: model,
                    }))}
                    searchable
                    searchPlaceholder={t('搜索模型')}
                  />
                </div>
                <div className="settings-row settings-model-list-row">
                  <div>
                    <strong>{t('可用模型')}</strong>
                    <span>{t('一个服务商可以维护多个模型，运行时可在下拉框里按服务商分组选择。')}</span>
                  </div>
                  <div className="settings-model-list-control">
                    {activeProviderModels.map((model, index) => (
                      <div className="settings-model-input-row" key={`${activeProvider}-${index}`}>
                        <AppInput
                          disabled={!activeProviderEnabled}
                          value={model}
                          onChange={(event) => updateActiveProviderModel(index, event.target.value)}
                          placeholder={activeProviderOption.defaultModel}
                        />
                        <button
                          aria-label={t('删除模型')}
                          className="settings-model-row-button danger"
                          disabled={!activeProviderEnabled || activeProviderModels.length <= 1}
                          onClick={() => removeActiveProviderModel(index)}
                          title={activeProviderModels.length <= 1 ? t('至少保留一个模型') : t('删除模型')}
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                    <button className="ui-button settings-add-model-button" disabled={!activeProviderEnabled} onClick={addActiveProviderModel} type="button">
                      <Plus size={15} />
                      {t('添加模型')}
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{t('访问密钥')}</strong>
                    <span>{t(activeProviderOption.keyLabel)}</span>
                  </div>
                  <AppInput
                    disabled={Boolean(activeProviderOption.localAuth)}
                    type="password"
                    value={activeProviderSettings.apiKey || ''}
                    onChange={(event) => updateActiveProviderSettings({ apiKey: event.target.value, hasApiKey: Boolean(event.target.value) || activeProviderSettings.hasApiKey })}
                    placeholder={activeProviderOption.localAuth
                      ? t('本地登录，无需 Key')
                      : activeProviderSettings.hasApiKey
                        ? t('已配置，留空表示不修改')
                        : t('填写该服务商的访问密钥')}
                  />
                </div>
                {activeProviderOption.baseUrlLabel ? (
                  <div className="settings-row">
                    <div>
                      <strong>{t(activeProviderOption.baseUrlLabel)}</strong>
                      <span>{t(activeProvider === 'openai-compatible'
                        ? '填写服务商提供的 OpenAI 兼容 Base URL，通常以 /v1 结尾。'
                        : '自定义兼容服务地址，留空使用默认地址。')}</span>
                    </div>
                    <AppInput value={activeProviderSettings.baseURL || ''} onChange={(event) => updateActiveProviderSettings({ baseURL: event.target.value })} placeholder={activeProviderOption.defaultBaseURL || t('默认地址')} />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeTab === 'skills' ? <SkillsManager onChanged={onSkillsChanged} showTitle={showSectionTitles} userId={normalizedUserId} /> : null}

          {activeTab === 'memory' ? renderPersonalMemoryPanel() : null}

          {activeTab === 'accounts' ? renderLoginAccountsPanel() : null}

          {activeTab !== 'general' && activeTab !== 'model' && activeTab !== 'skills' && activeTab !== 'memory' && activeTab !== 'accounts' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>{t(environmentSettingsTabs.find((tab) => tab.id === activeTab)?.label || '')}</h2>
                  <span>{t('{count} 项网页配置', { count: visibleEnvItems.length })}</span>
                </div>
                <button className="ui-button ui-button--primary" disabled={savingEnv || loading} onClick={saveEnv} type="button">
                  {savingEnv ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                  {t('保存')}
                </button>
              </div>
              {visibleEnvItems.length ? (
                <div className="settings-card">
                  {visibleEnvItems.map(({ item, index, definition }) => (
                    <div className={`settings-row settings-env-row${definition?.control === 'textarea' ? ' prompt-row' : ''}`} key={item.key}>
                      <div className="env-name" title={item.key}>
                        <strong>{definition?.label ? t(definition.label) : item.key}</strong>
                        <span>{definition?.description ? t(definition.description) : t('网页配置项。')}</span>
                      </div>
                      <div className="settings-row-control">
                        {renderRuntimeControl(item, index)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">{t('这个分类暂无配置。')}</div>
              )}
            </section>
          ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
