'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { ArrowLeft, FolderOpen, Loader2, PencilLine, Plus, Power, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
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
import { languageOptions } from '@/i18n/translations';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { ModelConfigRecord, ModelProvider, ModelProviderSettings, RuntimeEnvRecord } from '@/server/ai/schemas/test-case.schema';
import { useTheme } from '@/theme/ThemeProvider';
import { readApiJson } from '@/lib/api-client';

type EnvRow = Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'> & {
  updatedAt?: string;
};

type ModelConfig = Pick<ModelConfigRecord, 'provider' | 'providers' | 'updatedAt'>;

type PersonalMemoryScope = 'global' | 'domain';
type PersonalMemoryType = 'alias' | 'preference' | 'workflow' | 'domain_fact';
type PersonalMemoryStatus = 'active' | 'disabled';

type PersonalMemoryItem = {
  id: string;
  userId: string;
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
  downloadUrl?: (input: { defaultPath?: string; fileName?: string; url: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  getDownloads?: () => Promise<{ ok: boolean; downloads?: Array<{ completedAt?: number; error?: string; fileName?: string; id: string; path?: string; progress?: number; receivedBytes?: number; startedAt?: number; status?: string; totalBytes?: number; updatedAt?: number; url?: string }>; error?: string }>;
  onDownloadProgress?: (listener: (payload: { completedAt?: number; error?: string; fileName?: string; id: string; path?: string; progress?: number; receivedBytes?: number; startedAt?: number; status?: string; totalBytes?: number; updatedAt?: number; url?: string }) => void) => () => void;
  selectDirectory: (input?: { defaultPath?: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
};

declare global {
  interface Window {
    webPilotSystem?: SystemBridge;
  }
}

export const environmentSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'skills', label: 'Skills 管理' },
  { id: 'general', label: '通用设置' },
  { id: 'model', label: '模型配置' },
  { id: 'browser', label: '浏览器与截图' },
  { id: 'runtime', label: '运行控制' },
  { id: 'memory', label: '个性化记忆' },
  { id: 'debug', label: '调试与高级' },
];

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

const personalMemoryStatusOptions: Array<{ label: string; value: PersonalMemoryStatus }> = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];

function createPersonalMemoryDraft(): PersonalMemoryDraft {
  return {
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

function personalMemoryItemApiPath(item: Pick<PersonalMemoryItem, 'id' | 'userId'>) {
  const query = item.userId ? `?userId=${encodeURIComponent(item.userId)}` : '';
  return `/api/personal-memory/${encodeURIComponent(item.id)}${query}`;
}

function personalMemoryDraftApiPath(draft: PersonalMemoryDraft) {
  if (!draft.id) return '/api/personal-memory';
  const query = draft.userId ? `?userId=${encodeURIComponent(draft.userId)}` : '';
  return `/api/personal-memory/${encodeURIComponent(draft.id)}${query}`;
}

function createModelConfig(input?: Partial<ModelConfig>): ModelConfig {
  const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const current = input?.providers?.[definition.value];
    const models = modelListForProvider(definition, current);
    const model = defaultModelForProvider(definition, { ...current, models });
    providers[definition.value] = {
      defaultModel: model,
      model,
      models,
      apiKey: current?.apiKey || '',
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

function pushPromptPreviewText(parts: ReactNode[], text: string, keyPrefix: string) {
  const lines = text.split('\n');
  lines.forEach((line, lineIndex) => {
    if (line) parts.push(<span className="settings-prompt-preview-text" key={`${keyPrefix}-text-${lineIndex}`}>{line}</span>);
    if (lineIndex < lines.length - 1) parts.push(<br key={`${keyPrefix}-break-${lineIndex}`} />);
  });
}

function renderPromptTemplatePreview(
  value: string,
  variables: Array<{ label: string; value: string }>,
  translate: (value: string) => string,
) {
  const parts: ReactNode[] = [];
  const labelsByToken = new Map(variables.map((variable) => [variable.value, translate(variable.label)]));
  const pattern = /\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let hasToken = false;

  while ((match = pattern.exec(value)) !== null) {
    const token = match[0];
    const index = match.index;
    if (index > lastIndex) {
      pushPromptPreviewText(parts, value.slice(lastIndex, index), `text-${lastIndex}`);
    }
    parts.push(<span className="settings-prompt-token" key={`token-${index}`} title={token}>{labelsByToken.get(token) || token}</span>);
    lastIndex = index + token.length;
    hasToken = true;
  }

  if (!hasToken) return null;
  if (lastIndex < value.length) {
    pushPromptPreviewText(parts, value.slice(lastIndex), `text-${lastIndex}`);
  }
  return parts;
}

export function EnvironmentSettings({
  activeTab: controlledActiveTab,
  embedded = false,
  onActiveTabChange,
  onModelSaved,
  onRuntimeEnvSaved,
  onSkillsChanged,
  showTabs = true,
}: {
  activeTab?: SettingsTab;
  embedded?: boolean;
  onActiveTabChange?: (tab: SettingsTab) => void;
  onModelSaved?: () => void;
  onRuntimeEnvSaved?: () => void;
  onSkillsChanged?: () => void;
  showTabs?: boolean;
} = {}) {
  const { language, setLanguage, t } = useI18n();
  const { color, currentColor, scrollbarColor, setColor, setScrollbarColor } = useTheme();
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>('general');
  const [items, setItems] = useState<EnvRow[]>([]);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(() => createModelConfig());
  const [modelDraft, setModelDraft] = useState<ModelConfig>(() => createModelConfig());
  const [personalMemoryItems, setPersonalMemoryItems] = useState<PersonalMemoryItem[]>([]);
  const [personalMemoryDraft, setPersonalMemoryDraft] = useState<PersonalMemoryDraft>(() => createPersonalMemoryDraft());
  const [personalMemoryEditorMode, setPersonalMemoryEditorMode] = useState<PersonalMemoryEditorMode>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingEnv, setSavingEnv] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [loadingPersonalMemory, setLoadingPersonalMemory] = useState(false);
  const [savingPersonalMemory, setSavingPersonalMemory] = useState(false);
  const [updatingPersonalMemoryId, setUpdatingPersonalMemoryId] = useState('');
  const [deletingPersonalMemoryId, setDeletingPersonalMemoryId] = useState('');
  const [deletePersonalMemoryTarget, setDeletePersonalMemoryTarget] = useState<PersonalMemoryItem | null>(null);
  const [deletePersonalMemoryError, setDeletePersonalMemoryError] = useState('');
  const [hasDirectoryPicker, setHasDirectoryPicker] = useState(false);
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const activeTab = controlledActiveTab || internalActiveTab;
  const selectTab = onActiveTabChange || setInternalActiveTab;

  function optionLabel(option: { label: string; value: string }) {
    if (option.label === '关闭' && option.value === 'false') return language === 'en' ? 'Off' : '关闭';
    return t(option.label);
  }

  useEffect(() => {
    setHasDirectoryPicker(typeof window !== 'undefined' && Boolean(window.webPilotSystem?.selectDirectory));
    void load();
  }, []);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!personalMemoryEditorMode && !deletePersonalMemoryTarget) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || savingPersonalMemory || deletingPersonalMemoryId) return;
      if (personalMemoryEditorMode) closePersonalMemoryEditor();
      if (deletePersonalMemoryTarget) closeDeletePersonalMemoryModal();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [deletePersonalMemoryTarget, deletingPersonalMemoryId, personalMemoryEditorMode, savingPersonalMemory]);

  async function load() {
    setLoading(true);
    try {
      const [envResponse, modelResponse, memoryResponse] = await Promise.all([
        fetch('/api/settings/env', { cache: 'no-store' }),
        fetch('/api/settings/model', { cache: 'no-store' }),
        fetch('/api/personal-memory?includeDisabled=true', { cache: 'no-store' }),
      ]);
      const envData = await envResponse.json();
      const modelData = await modelResponse.json();
      const memoryData = memoryResponse.ok ? await memoryResponse.json() : { items: [] };
      const nextModel = createModelConfig(modelData.config);
      setItems(envData.saved || []);
      setModelConfig(nextModel);
      setModelDraft(nextModel);
      setPersonalMemoryItems(Array.isArray(memoryData.items) ? memoryData.items : []);
    } finally {
      setLoading(false);
    }
  }

  function update(index: number, patch: Partial<EnvRow>) {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, enabled: true, ...patch } : item)));
  }

  function insertRuntimeVariable(index: number, key: string, token: string) {
    const textarea = textareaRefs.current[key];
    const current = items[index]?.value || '';
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? current.length;
    const nextValue = `${current.slice(0, start)}${token}${current.slice(end)}`;
    update(index, { value: nextValue });
    requestAnimationFrame(() => {
      const nextTextarea = textareaRefs.current[key];
      const nextPosition = start + token.length;
      nextTextarea?.focus();
      nextTextarea?.setSelectionRange(nextPosition, nextPosition);
    });
  }

  async function chooseRuntimeDirectory(index: number, item: EnvRow) {
    const bridge = typeof window !== 'undefined' ? window.webPilotSystem : undefined;
    if (!bridge?.selectDirectory) return;
    const result = await bridge.selectDirectory({ defaultPath: item.value || undefined });
    if (result.ok && result.path) {
      update(index, { value: result.path });
    } else if (!result.ok && result.error) {
      window.alert(result.error);
    }
  }

  async function saveEnv() {
    setSavingEnv(true);
    startGlobalLoading(t('正在保存环境配置'));
    try {
      const response = await fetch('/api/settings/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map((item) => ({ ...item, enabled: true, secret: isSecret(item) })) }),
      });
      const data = await readApiJson<any>(response, t('保存环境配置失败'));
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
      const response = await fetch('/api/settings/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<any>(response, t('保存模型配置失败'));
      const nextModel = createModelConfig(data.config);
      setModelConfig(nextModel);
      setModelDraft(nextModel);
      onModelSaved?.();
    } finally {
      setSavingModel(false);
      stopGlobalLoading();
    }
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

  async function loadPersonalMemoryItems() {
    setLoadingPersonalMemory(true);
    try {
      const response = await fetch('/api/personal-memory?includeDisabled=true', { cache: 'no-store' });
      const data = await readApiJson<{ items?: PersonalMemoryItem[] }>(response, t('读取个性化记忆失败'));
      setPersonalMemoryItems(sortPersonalMemoryItems(Array.isArray(data.items) ? data.items : []));
    } finally {
      setLoadingPersonalMemory(false);
    }
  }

  function personalMemoryPayload() {
    return {
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
    setUpdatingPersonalMemoryId(item.id);
    try {
      const response = await fetch(personalMemoryItemApiPath(item), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: item.status === 'active' ? 'disabled' : 'active' }),
      });
      const data = await readApiJson<{ item?: PersonalMemoryItem }>(response, t('更新个性化记忆失败'));
      if (data.item) replacePersonalMemoryItem(data.item);
    } finally {
      setUpdatingPersonalMemoryId('');
    }
  }

  function requestDeletePersonalMemory(item: PersonalMemoryItem) {
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
      setDeletePersonalMemoryError(error instanceof Error ? error.message : t('删除个性化记忆失败'));
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
      const preview = renderPromptTemplatePreview(item.value, definition.variables || [], t);
      return (
        <div className="settings-prompt-control">
          <textarea
            ref={(node) => {
              textareaRefs.current[item.key] = node;
            }}
            className="textarea settings-control settings-textarea-control"
            placeholder={t('未设置')}
            value={item.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          {definition.variables?.length ? (
            <div className="settings-variable-tags" aria-label={t('可用变量')}>
              {definition.variables.map((variable) => (
                <button
                  className="settings-variable-tag"
                  key={variable.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertRuntimeVariable(index, item.key, variable.value)}
                  title={variable.description ? t(variable.description) : variable.value}
                  type="button"
                >
                  <span>{t(variable.label)}</span>
                  <code>{variable.value}</code>
                </button>
              ))}
            </div>
          ) : null}
          {preview ? <div className="settings-prompt-token-preview">{preview}</div> : null}
        </div>
      );
    }

    if (definition?.picker === 'directory') {
      return (
        <div className="settings-directory-control">
          <input
            className="input settings-control"
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
      <input
        className="input settings-control"
        inputMode={definition?.control === 'number' ? 'decimal' : undefined}
        placeholder={t('未设置')}
        type={definition?.control === 'number' ? 'number' : isSecret(item) ? 'password' : 'text'}
        value={item.value}
        onChange={(event) => update(index, { value: event.target.value })}
      />
    );
  }

  function renderPersonalMemoryEditorModal() {
    if (!personalMemoryEditorMode || !portalReady) return null;
    const editing = personalMemoryEditorMode === 'edit';
    return createPortal((
      <div className="ui-modal-overlay">
        <section
          aria-labelledby="personal-memory-modal-title"
          aria-modal="true"
          className="ui-modal ui-modal--personal-memory"
          role="dialog"
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
              <input
                className="input settings-control"
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
            <label className="personal-memory-field">
              <span>{t('状态')}</span>
              <CustomSelect
                className="settings-control"
                value={personalMemoryDraft.status}
                onChange={(value) => updatePersonalMemoryDraft({ status: value as PersonalMemoryStatus })}
                options={personalMemoryStatusOptions.map((option) => ({ label: t(option.label), value: option.value }))}
              />
            </label>
            <label className="personal-memory-field">
              <span>{t('常用短语')}</span>
              <input
                className="input settings-control"
                placeholder="jira"
                value={personalMemoryDraft.key}
                onChange={(event) => updatePersonalMemoryDraft({ key: event.target.value })}
              />
            </label>
            <label className="personal-memory-field">
              <span>{t('等价说法')}</span>
              <input
                className="input settings-control"
                placeholder={t('逗号或换行分隔')}
                value={personalMemoryDraft.aliasesText}
                onChange={(event) => updatePersonalMemoryDraft({ aliasesText: event.target.value })}
              />
            </label>
            <label className="personal-memory-field wide">
              <span>{t('说明')}</span>
              <textarea
                className="textarea settings-control"
                placeholder={t('公司私域 Jira，地址是 ...')}
                value={personalMemoryDraft.value}
                onChange={(event) => updatePersonalMemoryDraft({ value: event.target.value })}
              />
            </label>
          </div>

          <footer className="ui-modal-footer">
            <button className="ui-button ui-button--neutral" disabled={savingPersonalMemory} onClick={closePersonalMemoryEditor} type="button">
              {t('取消')}
            </button>
            <button className="ui-button ui-icon-button" disabled={savingPersonalMemory} onClick={() => void savePersonalMemory()} type="button">
              {savingPersonalMemory ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              {t(editing ? '保存记忆' : '新增记忆')}
            </button>
          </footer>
        </section>
      </div>
    ), document.body);
  }

  function renderDeletePersonalMemoryModal() {
    if (!deletePersonalMemoryTarget || !portalReady) return null;
    const deleting = deletingPersonalMemoryId === deletePersonalMemoryTarget.id;
    return createPortal((
      <div className="ui-modal-overlay" onMouseDown={closeDeletePersonalMemoryModal}>
        <section
          aria-labelledby="personal-memory-delete-title"
          aria-modal="true"
          className="ui-modal ui-modal--compact"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <header className="ui-modal-header">
            <h2 className="ui-modal-title" id="personal-memory-delete-title">{t('删除记忆')}</h2>
            <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" disabled={deleting} onClick={closeDeletePersonalMemoryModal} type="button">
              <X size={16} />
            </button>
          </header>
          <div className="ui-modal-body skills-manager-delete-body">
            <h3>{deletePersonalMemoryTarget.key}</h3>
            <p>{t('确认删除这条记忆？')}</p>
            {deletePersonalMemoryError ? <p className="personal-memory-delete-error">{deletePersonalMemoryError}</p> : null}
          </div>
          <footer className="ui-modal-footer">
            <button className="ui-button ui-button--neutral" disabled={deleting} onClick={closeDeletePersonalMemoryModal} type="button">
              {t('取消')}
            </button>
            <button className="ui-button ui-icon-button ui-icon-button--danger" disabled={deleting} onClick={() => void confirmDeletePersonalMemory()} type="button">
              {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
              {t('删除')}
            </button>
          </footer>
        </section>
      </div>
    ), document.body);
  }

  function renderPersonalMemoryPanel() {
    return (
      <section className="personal-memory-settings">
        <div className="settings-section-head">
          <div>
            <h2>{t('个性化记忆')}</h2>
            <span>{t('{count} 条记录，文件：.data/personal-memory/items.json', { count: personalMemoryItems.length })}</span>
          </div>
          <div className="personal-memory-head-actions">
            <button className="ui-button ui-button--neutral" disabled={loadingPersonalMemory} onClick={() => void loadPersonalMemoryItems()} type="button">
              {loadingPersonalMemory ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              {t('刷新')}
            </button>
            <button className="ui-button ui-icon-button" onClick={openCreatePersonalMemory} type="button">
              <Plus size={15} />
              {t('新增记忆')}
            </button>
          </div>
        </div>

        {loadingPersonalMemory ? (
          <section className="settings-loading-panel compact" role="status" aria-live="polite">
            <Loader2 className="spin" size={18} />
            <div>
              <h2>{t('正在读取个性化记忆')}</h2>
            </div>
          </section>
        ) : personalMemoryItems.length ? (
          <div className="personal-memory-list">
            {personalMemoryItems.map((item) => (
              <article className={`personal-memory-item ${item.status}`} data-i18n-skip key={item.id}>
                <div className="personal-memory-item-main">
                  <div className="personal-memory-meta">
                    <span>{item.scope === 'domain' ? item.domain || t('未填域名') : t('全局')}</span>
                    <span>{t(personalMemoryTypeLabel(item.type))}</span>
                    <span className={`personal-memory-status ${item.status}`}>{item.status === 'active' ? t('启用') : t('停用')}</span>
                    {item.useCount ? <span>{t('使用 {count} 次', { count: item.useCount })}</span> : null}
                  </div>
                  <h3>{item.key}</h3>
                  <p>{item.value}</p>
                  {item.aliases?.length ? <small>{item.aliases.join(', ')}</small> : null}
                </div>
                <div className="personal-memory-actions">
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
                    aria-label={item.status === 'active' ? t('停用记忆') : t('启用记忆')}
                    className="settings-model-row-button"
                    disabled={updatingPersonalMemoryId === item.id || deletingPersonalMemoryId === item.id}
                    onClick={() => void togglePersonalMemory(item)}
                    title={item.status === 'active' ? t('停用记忆') : t('启用记忆')}
                    type="button"
                  >
                    {updatingPersonalMemoryId === item.id ? <Loader2 className="spin" size={15} /> : <Power size={15} />}
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
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">{t('暂无个性化记忆')}</div>
        )}
        {renderPersonalMemoryEditorModal()}
        {renderDeletePersonalMemoryModal()}
      </section>
    );
  }

  const editingModelConfig = modelDraft || modelConfig;
  const activeProvider = editingModelConfig.provider;
  const activeProviderOption = modelProviderDefinition(activeProvider);
  const activeProviderSettings = providerSettings(editingModelConfig, activeProvider);
  const activeProviderModels = draftModelRows(activeProviderOption, activeProviderSettings);
  const activeProviderDefaultModel = activeProviderSettings.defaultModel || activeProviderSettings.model || activeProviderOption.defaultModel;
  const visibleEnvItems = items
    .map((item, index) => ({ item, index, definition: runtimeEnvDefinition(item.key) }))
    .filter(({ definition }) => activeTab !== 'general' && activeTab !== 'model' && activeTab !== 'skills' && activeTab !== 'memory' && definition?.tab === activeTab);

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
            {environmentSettingsTabs.map((tab) => (
              <button className={activeTab === tab.id ? 'active' : undefined} key={tab.id} onClick={() => selectTab(tab.id)} type="button">
                {t(tab.label)}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="settings-content">
          {loading ? (
            <section className="settings-loading-panel" role="status" aria-live="polite">
              <Loader2 className="spin" size={18} />
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
                    <strong>{language === 'en' ? 'Theme color' : '主题色'}</strong>
                    <span>{language === 'en' ? 'Adjust the theme color used by buttons, scrollbars, and highlighted states.' : '调整按钮、滚动条和高亮状态使用的主题色。'}</span>
                  </div>
                  <div className="theme-color-picker">
                    <label>
                      <span style={{ backgroundColor: currentColor.accent }} />
                      <input
                        aria-label={language === 'en' ? 'Theme color' : '主题色'}
                        type="color"
                        value={color}
                        onChange={(event) => setColor(event.target.value)}
                      />
                    </label>
                    <code>{color.toUpperCase()}</code>
                  </div>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{language === 'en' ? 'Scrollbar thumb color' : '滚动条滑块颜色'}</strong>
                    <span>{language === 'en' ? 'Choose a custom color for scrollbar thumbs.' : '自定义全局滚动条滑块颜色。'}</span>
                  </div>
                  <div className="theme-color-picker">
                    <label>
                      <span style={{ backgroundColor: scrollbarColor }} />
                      <input
                        aria-label={language === 'en' ? 'Scrollbar thumb color' : '滚动条滑块颜色'}
                        type="color"
                        value={scrollbarColor}
                        onChange={(event) => setScrollbarColor(event.target.value)}
                      />
                    </label>
                    <code>{scrollbarColor.toUpperCase()}</code>
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
                <button className="ui-button ui-icon-button" disabled={savingModel || loading} onClick={saveModel} type="button">
                  {savingModel ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                  {t('保存')}
                </button>
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
                    <strong>{t('默认模型')}</strong>
                    <span>{t('从当前服务商配置的模型列表中选择默认模型。')}</span>
                  </div>
                  <CustomSelect
                    className="settings-control"
                    value={activeProviderDefaultModel}
                    onChange={(nextModel) => updateActiveProviderSettings({ defaultModel: nextModel, model: nextModel })}
                    options={modelListForProvider(activeProviderOption, activeProviderSettings).map((model) => ({
                      label: model,
                      value: model,
                    }))}
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
                        <input
                          className="input settings-control"
                          value={model}
                          onChange={(event) => updateActiveProviderModel(index, event.target.value)}
                          placeholder={activeProviderOption.defaultModel}
                        />
                        <button
                          aria-label={t('删除模型')}
                          className="settings-model-row-button danger"
                          disabled={activeProviderModels.length <= 1}
                          onClick={() => removeActiveProviderModel(index)}
                          title={activeProviderModels.length <= 1 ? t('至少保留一个模型') : t('删除模型')}
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                    <button className="ui-button ui-button--neutral" onClick={addActiveProviderModel} type="button">
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
                  <input
                    className="input settings-control"
                    disabled={Boolean(activeProviderOption.localAuth)}
                    type="password"
                    value={activeProviderSettings.apiKey || ''}
                    onChange={(event) => updateActiveProviderSettings({ apiKey: event.target.value })}
                    placeholder={activeProviderOption.localAuth ? t('本地登录，无需 Key') : t('填写该服务商的访问密钥')}
                  />
                </div>
                {activeProviderOption.baseUrlLabel ? (
                  <div className="settings-row">
                    <div>
                      <strong>{t(activeProviderOption.baseUrlLabel)}</strong>
                      <span>{t('自定义兼容服务地址，留空使用默认地址。')}</span>
                    </div>
                    <input className="input settings-control" value={activeProviderSettings.baseURL || ''} onChange={(event) => updateActiveProviderSettings({ baseURL: event.target.value })} placeholder={activeProviderOption.defaultBaseURL || t('默认地址')} />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeTab === 'skills' ? <SkillsManager onChanged={onSkillsChanged} /> : null}

          {activeTab === 'memory' ? renderPersonalMemoryPanel() : null}

          {activeTab !== 'general' && activeTab !== 'model' && activeTab !== 'skills' && activeTab !== 'memory' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>{t(environmentSettingsTabs.find((tab) => tab.id === activeTab)?.label || '')}</h2>
                  <span>{t('{count} 项网页配置', { count: visibleEnvItems.length })}</span>
                </div>
                <button className="ui-button ui-icon-button" disabled={savingEnv || loading} onClick={saveEnv} type="button">
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
