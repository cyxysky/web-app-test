'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TextArea } from '@heroui/react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, BadgeDollarSign, Building2, ChevronDown, CircleCheck, Copy, FileKey2, FileText, FolderOpen, ImageIcon, KeyRound, Loader2, MapPin, Maximize2, PencilLine, Phone, PlayCircle, Plus, RefreshCw, Save, Search, Trash2, UserRound, X } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal';
import { SkillsManager } from '@/components/SkillsManager';
import {
  defaultModelForProvider,
  modelListForProvider,
  modelProviderDefinitions,
  modelProviderDefinition,
  runtimeEnvDefinition,
  uniqueModelIds,
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
import { ModelBrandIcon } from '@/components/ModelBrandIcon';
import { AppInput } from '@/components/ui/app-input';
import { AppModal } from '@/components/ui/app-modal';
import { ColorPickerField } from '@/components/ui/color-picker-field';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import {
  defaultModelCapabilities,
  normalizedModelCapabilities,
} from '@/lib/model-capabilities';
import {
  environmentSettingsTabs,
  environmentSettingsTabsForUser,
} from '@/components/environment-settings-model';
import {
  duplicateExtraRequestParameterKeys,
  parseExtraRequestParameterPairs,
  serializeExtraRequestParameterPairs,
  type ExtraRequestParameterPair,
} from '@/lib/extra-request-parameters';
import type { SensitiveDataEvaluationCase } from '@/lib/sensitive-data-evaluation';

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

type ExtraRequestParameterDraft = ExtraRequestParameterPair & {
  id: string;
};

type SensitiveDataTestReplacement = {
  original: string;
  placeholder: string;
  label: string;
  start: number;
  end: number;
};

type SensitiveDataTestResult = {
  text: string;
  replacements: SensitiveDataTestReplacement[];
};

type SensitiveDataEvaluationDraft = Omit<SensitiveDataEvaluationCase, 'expectedValues'> & {
  expectedValuesText: string;
};

type SensitiveDataEvaluationCaseResult = {
  id: string;
  passed: boolean;
  text: string;
  detectedValues: string[];
  missingValues: string[];
  unexpectedValues: string[];
};

type SensitiveDataEvaluationRun = {
  summary: {
    total: number;
    passed: number;
    failed: number;
    precision: number;
    recall: number;
  };
  results: SensitiveDataEvaluationCaseResult[];
};

type VisibleEnvSetting = {
  item: EnvRow;
  index: number;
  definition: ReturnType<typeof runtimeEnvDefinition>;
};

function SettingsGroupCard({
  children,
  className = '',
  initiallyOpen = true,
  title,
}: {
  children: ReactNode;
  className?: string;
  initiallyOpen?: boolean;
  title: string;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  return (
    <div className={`settings-group-card${expanded ? ' is-expanded' : ''}${className ? ` ${className}` : ''}`}>
      <button
        aria-expanded={expanded}
        className="settings-group-card-head"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <h3>{title}</h3>
        <ChevronDown aria-hidden="true" size={17} />
      </button>
      {expanded ? <div className="settings-group-card-body">{children}</div> : null}
    </div>
  );
}

function runtimeSettingGroup(tab: SettingsTab, key: string) {
  if (tab === 'browser') {
    if (/^BROWSER_(?:PREVIEW|SCREENCAST|OUTPUT)/.test(key)) return '实时预览';
    if (/^(?:ELECTRON_|HEADLESS_|BROWSER_(?:PROFILE|USER_BROWSER|VIEWPORT))/.test(key)) return '浏览器实例';
    return '导航与诊断';
  }
  if (tab === 'sensitive-data') {
    if (/^AI_SENSITIVE_DATA_FILTER_/.test(key)) return '脱敏策略';
    if (/^GLINER_(?:MODEL|PII_MODEL)$/.test(key)) return '脱敏模型';
    return '推理服务';
  }
  if (tab === 'runtime') {
    if (/^(?:SQLITE_|OFFICE_)/.test(key)) return '数据与文件';
    if (/^AI_SUBAGENT_/.test(key)) return '子 Agent';
    if (/^BROWSER_CHAT_/.test(key)) return '对话运行';
    if (/^AI_PERSONAL_MEMORY_/.test(key)) return '个性化记忆';
    if (/^AI_(?:CONTEXT|GLM_CONTEXT|IMAGE_CONTEXT|VISUAL_)/.test(key)) return '上下文管理';
    return 'Agent 运行';
  }
  if (tab === 'debug') return key.startsWith('CODEX_') ? 'Codex CLI' : '调试与追踪';
  return '配置';
}

function groupVisibleEnvSettings(tab: SettingsTab, settings: VisibleEnvSetting[]) {
  const groups = new Map<string, VisibleEnvSetting[]>();
  for (const setting of settings) {
    const title = runtimeSettingGroup(tab, setting.item.key);
    const group = groups.get(title) || [];
    group.push(setting);
    groups.set(title, group);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

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
      displayName: current?.displayName || '',
      enabled: current?.enabled === true,
      defaultModel: model,
      model,
      models,
      modelCapabilities: normalizedModelCapabilities(definition.value, models, current?.modelCapabilities),
      apiKey: current?.apiKey || '',
      hasApiKey: Boolean(current?.hasApiKey || current?.apiKey),
      baseURL: current?.baseURL ?? definition.defaultBaseURL ?? '',
      extraRequestParameters: current?.extraRequestParameters || '',
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
    displayName: '',
    enabled: false,
    defaultModel: definition.defaultModel,
    model: definition.defaultModel,
    models: modelListForProvider(definition),
    modelCapabilities: normalizedModelCapabilities(definition.value, modelListForProvider(definition)),
    apiKey: '',
    baseURL: definition.defaultBaseURL || '',
    extraRequestParameters: '',
  };
}

function extraRequestParameterDrafts(config: ModelConfig) {
  const drafts: Partial<Record<ModelProvider, ExtraRequestParameterDraft[]>> = {};
  for (const definition of modelProviderDefinitions) {
    drafts[definition.value] = parseExtraRequestParameterPairs(
      providerSettings(config, definition.value).extraRequestParameters,
    ).map((pair, index) => ({
      ...pair,
      id: `${definition.value}:${index}:${pair.key}`,
    }));
  }
  return drafts;
}

function sensitiveDataEvaluationDrafts(cases: SensitiveDataEvaluationCase[] = []): SensitiveDataEvaluationDraft[] {
  return cases.map((item) => ({
    id: item.id,
    name: item.name,
    text: item.text,
    expectedValuesText: item.expectedValues.join('\n'),
  }));
}

function sensitiveDataEvaluationPayload(cases: SensitiveDataEvaluationDraft[]): SensitiveDataEvaluationCase[] {
  return cases.map((item) => ({
    id: item.id,
    name: item.name.trim(),
    text: item.text,
    expectedValues: [...new Set(item.expectedValuesText
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean))],
  }));
}

function draftModelRows(definition: ReturnType<typeof modelProviderDefinition>, settings: ModelProviderSettings) {
  return Array.isArray(settings.models) && settings.models.length
    ? settings.models
    : uniqueModelIds([settings.defaultModel, settings.model]).filter((model) => !(
      definition.value.startsWith('openai-compatible')
      && model === 'custom-model'
    ));
}

type SensitiveValueGroupId = 'organization' | 'project' | 'person' | 'contact' | 'identity' | 'finance' | 'address' | 'security' | 'other';

const sensitiveValueGroupOrder: Array<{ id: SensitiveValueGroupId; label: string }> = [
  { id: 'organization', label: '组织机构' },
  { id: 'project', label: '合同与项目' },
  { id: 'person', label: '人员信息' },
  { id: 'contact', label: '联系方式' },
  { id: 'identity', label: '身份与证件' },
  { id: 'finance', label: '财务与账户' },
  { id: 'address', label: '地址信息' },
  { id: 'security', label: '安全凭据' },
  { id: 'other', label: '其他信息' },
];

function sensitiveValueGroup(text: string, value: string): SensitiveValueGroupId {
  const index = text.indexOf(value);
  const before = index >= 0 ? text.slice(0, index) : '';
  const clauseStart = Math.max(before.lastIndexOf('；'), before.lastIndexOf('。'), before.lastIndexOf('\n'), before.lastIndexOf('，'));
  const context = index >= 0 ? `${before.slice(clauseStart + 1)}${value}` : value;
  if (/API|Key|令牌|密钥|token|ghp_|AKIA|密码|服务器IP|公网IP/i.test(context)) return 'security';
  if (/地址|办公地|交付地|邮寄地/.test(context)) return 'address';
  if (/身份证|护照|出生日期|实名|证件/.test(context)) return 'identity';
  if (/银行账号|账户|账号|金额|薪|预算|回款|人民币|万元|亿元|K\/月|元\/月|元\/年|￥|¥/.test(context)) return 'finance';
  if (/合同|项目|编号|编码|代号/.test(context)) return 'project';
  if (/负责人|联系人|审批人|职位|岗位|工号|用户名|员工|研发|工程师|总监|财务官/.test(context)) return 'person';
  if (/客户|供应商|实施方|相对方|公司|产品|平台|系统|医疗|零售|智造/.test(context)) return 'organization';
  if (/邮箱|电话|手机|@/.test(context)) return 'contact';
  return 'other';
}

function groupedSensitiveValues(text: string, values: string[]) {
  const groups = new Map<SensitiveValueGroupId, string[]>();
  for (const value of values) {
    const group = sensitiveValueGroup(text, value);
    groups.set(group, [...(groups.get(group) || []), value]);
  }
  return sensitiveValueGroupOrder.flatMap((group) => {
    const items = groups.get(group.id) || [];
    return items.length ? [{ ...group, items }] : [];
  });
}

function highlightedSensitiveText(text: string, values: string[]): ReactNode[] {
  const matches = values
    .flatMap((value) => {
      const start = text.indexOf(value);
      return start >= 0 ? [{ start, end: start + value.length, value }] : [];
    })
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((match, index, matches) => index === 0 || match.start >= matches[index - 1].end);
  if (!matches.length) return [text];
  const output: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) output.push(text.slice(cursor, match.start));
    output.push(<mark key={`${match.start}:${match.value}`}>{text.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  }
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

function SensitiveValueGroupIcon({ id }: { id: SensitiveValueGroupId }) {
  const props = { 'aria-hidden': true, size: 16, strokeWidth: 1.9 } as const;
  if (id === 'organization') return <Building2 {...props} />;
  if (id === 'project') return <FileText {...props} />;
  if (id === 'person') return <UserRound {...props} />;
  if (id === 'contact') return <Phone {...props} />;
  if (id === 'finance') return <BadgeDollarSign {...props} />;
  if (id === 'address') return <MapPin {...props} />;
  return <FileKey2 {...props} />;
}

function evaluationCaseDisplayName(name: string, index: number) {
  return name.trim().replace(/^综合业务场景\s*[·・]\s*/, '') || `用例 ${index + 1}`;
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
  const [extraRequestParameterRows, setExtraRequestParameterRows] = useState<Partial<Record<ModelProvider, ExtraRequestParameterDraft[]>>>(() => (
    extraRequestParameterDrafts(createModelConfig(initialData?.modelConfig))
  ));
  const extraRequestParameterIdRef = useRef(0);
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
  const [sensitiveDataTestInput, setSensitiveDataTestInput] = useState('');
  const [sensitiveDataTestResult, setSensitiveDataTestResult] = useState<SensitiveDataTestResult | null>(null);
  const [sensitiveDataTestError, setSensitiveDataTestError] = useState('');
  const [testingSensitiveData, setTestingSensitiveData] = useState(false);
  const [sensitiveDataEvaluationCases, setSensitiveDataEvaluationCases] = useState<SensitiveDataEvaluationDraft[]>([]);
  const [sensitiveDataEvaluationRun, setSensitiveDataEvaluationRun] = useState<SensitiveDataEvaluationRun | null>(null);
  const [selectedSensitiveDataEvaluationCaseId, setSelectedSensitiveDataEvaluationCaseId] = useState('');
  const [sensitiveDataEvaluationSearch, setSensitiveDataEvaluationSearch] = useState('');
  const [sensitiveDataEvaluationPanelTab, setSensitiveDataEvaluationPanelTab] = useState<'expected' | 'result'>('expected');
  const [sensitiveDataEvaluationExpanded, setSensitiveDataEvaluationExpanded] = useState(false);
  const [sensitiveDataEvaluationNewExpectedValue, setSensitiveDataEvaluationNewExpectedValue] = useState('');
  const [collapsedSensitiveDataGroups, setCollapsedSensitiveDataGroups] = useState<Set<string>>(() => new Set());
  const [sensitiveDataEvaluationError, setSensitiveDataEvaluationError] = useState('');
  const [sensitiveDataEvaluationLoaded, setSensitiveDataEvaluationLoaded] = useState(false);
  const [loadingSensitiveDataEvaluation, setLoadingSensitiveDataEvaluation] = useState(false);
  const [savingSensitiveDataEvaluation, setSavingSensitiveDataEvaluation] = useState(false);
  const [runningSensitiveDataEvaluation, setRunningSensitiveDataEvaluation] = useState(false);
  const sensitiveDataEvaluationIdRef = useRef(0);
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

  useEffect(() => {
    if (
      activeTab !== 'sensitive-data'
      || sensitiveDataEvaluationLoaded
      || (adminSettingsPasswordRequired && !adminSettingsAccessToken)
    ) return;
    const controller = new AbortController();
    setLoadingSensitiveDataEvaluation(true);
    setSensitiveDataEvaluationError('');
    void (async () => {
      try {
        const response = await fetch(withWebPilotBasePath('/api/settings/sensitive-data-evaluation'), {
          cache: 'no-store',
          headers: adminSettingsAccessToken ? { Authorization: `Bearer ${adminSettingsAccessToken}` } : {},
          signal: controller.signal,
        });
        const data = await readApiJson<{ cases?: SensitiveDataEvaluationCase[] }>(response, '读取脱敏评测集失败');
        if (controller.signal.aborted) return;
        const drafts = sensitiveDataEvaluationDrafts(data.cases);
        setSensitiveDataEvaluationCases(drafts);
        setSelectedSensitiveDataEvaluationCaseId((current) => drafts.some((item) => item.id === current) ? current : drafts[0]?.id || '');
        setSensitiveDataEvaluationLoaded(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSensitiveDataEvaluationError(error instanceof Error ? t(error.message) : t('读取脱敏评测集失败'));
      } finally {
        if (!controller.signal.aborted) setLoadingSensitiveDataEvaluation(false);
      }
    })();
    return () => controller.abort();
  // Loading is intentionally keyed to the selected tab and admin access grant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, adminSettingsAccessToken, adminSettingsPasswordRequired]);

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
      setExtraRequestParameterRows(extraRequestParameterDrafts(nextModel));
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

  async function runSensitiveDataTest() {
    if (!sensitiveDataTestInput.trim() || testingSensitiveData) return;
    setTestingSensitiveData(true);
    setSensitiveDataTestError('');
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/sensitive-data-test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminSettingsAuthorizationHeaders },
        body: JSON.stringify({ text: sensitiveDataTestInput }),
      });
      const data = await readApiJson<SensitiveDataTestResult>(response, t('敏感数据过滤测试失败'));
      setSensitiveDataTestResult({
        text: String(data.text || ''),
        replacements: Array.isArray(data.replacements) ? data.replacements : [],
      });
    } catch (error) {
      setSensitiveDataTestResult(null);
      setSensitiveDataTestError(error instanceof Error ? t(error.message) : t('敏感数据过滤测试失败'));
    } finally {
      setTestingSensitiveData(false);
    }
  }

  function addSensitiveDataEvaluationCase() {
    const id = `evaluation:${Date.now()}:${sensitiveDataEvaluationIdRef.current++}`;
    setSensitiveDataEvaluationCases((current) => [...current, { id, name: '', text: '', expectedValuesText: '' }]);
    setSelectedSensitiveDataEvaluationCaseId(id);
    setSensitiveDataEvaluationPanelTab('expected');
    setSensitiveDataEvaluationRun(null);
    setSensitiveDataEvaluationError('');
  }

  function updateSensitiveDataEvaluationCase(id: string, patch: Partial<SensitiveDataEvaluationDraft>) {
    setSensitiveDataEvaluationCases((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setSensitiveDataEvaluationRun(null);
    setSensitiveDataEvaluationError('');
  }

  function removeSensitiveDataEvaluationCase(id: string) {
    setSensitiveDataEvaluationCases((current) => {
      const next = current.filter((item) => item.id !== id);
      setSelectedSensitiveDataEvaluationCaseId((selected) => selected === id ? next[0]?.id || '' : selected);
      return next;
    });
    setSensitiveDataEvaluationRun(null);
    setSensitiveDataEvaluationError('');
  }

  function addOpenAICompatibleProvider() {
    const compatibleProviders: ModelProvider[] = ['openai-compatible', 'openai-compatible-2', 'openai-compatible-3'];
    setModelDraft((current) => {
      const next = createModelConfig(current);
      const provider = compatibleProviders.find((candidate) => {
        const settings = providerSettings(next, candidate);
        return !settings.enabled
          && !settings.displayName?.trim()
          && !settings.apiKey
          && !settings.hasApiKey
          && !settings.baseURL;
      });
      if (!provider) return next;
      const sequence = compatibleProviders.indexOf(provider) + 1;
      return {
        ...next,
        provider,
        providers: {
          ...next.providers,
          [provider]: {
            ...providerSettings(next, provider),
            displayName: `OpenAI 兼容供应商 ${sequence}`,
            enabled: true,
          },
        },
      };
    });
  }

  function addSensitiveDataEvaluationExpectedValue(caseId: string) {
    const value = sensitiveDataEvaluationNewExpectedValue.trim();
    if (!value) return;
    const target = sensitiveDataEvaluationCases.find((item) => item.id === caseId);
    if (!target) return;
    const values = target.expectedValuesText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!values.includes(value)) values.push(value);
    updateSensitiveDataEvaluationCase(caseId, { expectedValuesText: values.join('\n') });
    setSensitiveDataEvaluationNewExpectedValue('');
  }

  function removeSensitiveDataEvaluationExpectedValue(caseId: string, value: string) {
    const target = sensitiveDataEvaluationCases.find((item) => item.id === caseId);
    if (!target) return;
    const values = target.expectedValuesText.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && item !== value);
    updateSensitiveDataEvaluationCase(caseId, { expectedValuesText: values.join('\n') });
  }

  function toggleSensitiveDataEvaluationGroup(caseId: string, groupId: string) {
    const key = `${caseId}:${groupId}`;
    setCollapsedSensitiveDataGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function validSensitiveDataEvaluationPayload() {
    if (sensitiveDataEvaluationCases.some((item) => !item.text.trim())) {
      setSensitiveDataEvaluationError(t('评测用例文本不能为空。'));
      return null;
    }
    return sensitiveDataEvaluationPayload(sensitiveDataEvaluationCases);
  }

  async function saveSensitiveDataEvaluationCases() {
    if (savingSensitiveDataEvaluation) return;
    const cases = validSensitiveDataEvaluationPayload();
    if (!cases) return;
    setSavingSensitiveDataEvaluation(true);
    setSensitiveDataEvaluationError('');
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/sensitive-data-evaluation'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...adminSettingsAuthorizationHeaders },
        body: JSON.stringify({ cases }),
      });
      const data = await readApiJson<{ cases?: SensitiveDataEvaluationCase[] }>(response, t('保存脱敏评测集失败'));
      const drafts = sensitiveDataEvaluationDrafts(data.cases);
      setSensitiveDataEvaluationCases(drafts);
      setSelectedSensitiveDataEvaluationCaseId((current) => drafts.some((item) => item.id === current) ? current : drafts[0]?.id || '');
      setSensitiveDataEvaluationLoaded(true);
    } catch (error) {
      setSensitiveDataEvaluationError(error instanceof Error ? t(error.message) : t('保存脱敏评测集失败'));
    } finally {
      setSavingSensitiveDataEvaluation(false);
    }
  }

  async function runSensitiveDataEvaluation() {
    if (runningSensitiveDataEvaluation) return;
    const cases = validSensitiveDataEvaluationPayload();
    if (!cases) return;
    if (!cases.length) {
      setSensitiveDataEvaluationError(t('请至少添加一个评测用例。'));
      return;
    }
    setRunningSensitiveDataEvaluation(true);
    setSensitiveDataEvaluationError('');
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/sensitive-data-evaluation'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminSettingsAuthorizationHeaders },
        body: JSON.stringify({ cases }),
      });
      const data = await readApiJson<SensitiveDataEvaluationRun>(response, t('运行脱敏评测失败'));
      setSensitiveDataEvaluationRun(data);
    } catch (error) {
      setSensitiveDataEvaluationRun(null);
      setSensitiveDataEvaluationError(error instanceof Error ? t(error.message) : t('运行脱敏评测失败'));
    } finally {
      setRunningSensitiveDataEvaluation(false);
    }
  }

  function commitActiveProviderExtraRequestParameters(rows: ExtraRequestParameterDraft[]) {
    setExtraRequestParameterRows((current) => ({
      ...current,
      [activeProvider]: rows,
    }));
    updateActiveProviderSettings({ extraRequestParameters: serializeExtraRequestParameterPairs(rows) });
  }

  function addActiveProviderExtraRequestParameter() {
    commitActiveProviderExtraRequestParameters([
      ...activeProviderExtraRequestParameterRows,
      {
        id: `${activeProvider}:new:${extraRequestParameterIdRef.current++}`,
        key: '',
        value: '',
      },
    ]);
  }

  function updateActiveProviderExtraRequestParameter(
    id: string,
    patch: Partial<ExtraRequestParameterPair>,
  ) {
    commitActiveProviderExtraRequestParameters(
      activeProviderExtraRequestParameterRows.map((row) => row.id === id ? { ...row, ...patch } : row),
    );
  }

  function removeActiveProviderExtraRequestParameter(id: string) {
    commitActiveProviderExtraRequestParameters(
      activeProviderExtraRequestParameterRows.filter((row) => row.id !== id),
    );
  }

  function setActiveProviderModels(
    models: string[],
    defaultModel?: string,
    modelCapabilitiesInput?: ModelProviderSettings['modelCapabilities'],
  ) {
    setModelDraft((current) => {
      const next = {
        ...current,
        providers: { ...current.providers },
      };
      const provider = next.provider;
      const currentSettings = providerSettings(next, provider);
      const normalizedModels = models.map((item) => item.trim()).filter(Boolean);
      const requestedModel = defaultModel || currentSettings.defaultModel || currentSettings.model || '';
      const fallbackModel = normalizedModels.includes(requestedModel) ? requestedModel : normalizedModels[0] || '';
      return {
        ...next,
        providers: {
          ...next.providers,
          [provider]: {
            ...currentSettings,
            defaultModel: fallbackModel,
            model: fallbackModel,
            models,
            modelCapabilities: normalizedModelCapabilities(
              provider,
              normalizedModels,
              modelCapabilitiesInput || currentSettings.modelCapabilities,
            ),
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
    const currentDefault = activeProviderSettings.defaultModel || activeProviderSettings.model || '';
    const nextDefault = previous === currentDefault || !trimmedRows.includes(currentDefault)
      ? value.trim() || trimmedRows[0] || ''
      : currentDefault;
    const nextCapabilities = { ...(activeProviderSettings.modelCapabilities || {}) };
    const previousCapability = nextCapabilities[previous]
      || defaultModelCapabilities(activeProvider, previous);
    delete nextCapabilities[previous];
    if (value.trim()) nextCapabilities[value.trim()] = previousCapability;
    setActiveProviderModels(rows, nextDefault, nextCapabilities);
  }

  function addActiveProviderModel() {
    setActiveProviderModels([...draftModelRows(activeProviderOption, activeProviderSettings), ''], activeProviderSettings.defaultModel || activeProviderSettings.model);
  }

  function removeActiveProviderModel(index: number) {
    const rows = draftModelRows(activeProviderOption, activeProviderSettings);
    if (!rows.length) return;
    const removed = rows[index];
    const nextRows = rows.filter((_, itemIndex) => itemIndex !== index);
    const remaining = nextRows.map((item) => item.trim()).filter(Boolean);
    const currentDefault = activeProviderSettings.defaultModel || activeProviderSettings.model || '';
    const nextDefault = removed === currentDefault || !remaining.includes(currentDefault)
      ? remaining[0] || ''
      : currentDefault;
    const nextCapabilities = { ...(activeProviderSettings.modelCapabilities || {}) };
    delete nextCapabilities[removed];
    setActiveProviderModels(nextRows, nextDefault, nextCapabilities);
  }

  function setActiveModelImageInput(model: string, imageInput: boolean) {
    if (!model.trim()) return;
    updateActiveProviderSettings({
      modelCapabilities: {
        ...(activeProviderSettings.modelCapabilities || {}),
        [model]: { imageInput },
      },
    });
  }

  async function saveModel() {
    for (const definition of modelProviderDefinitions) {
      const duplicates = duplicateExtraRequestParameterKeys(extraRequestParameterRows[definition.value] || []);
      if (duplicates.length) {
        window.alert(t('额外请求参数名不能重复：{keys}', { keys: duplicates.join(', ') }));
        return;
      }
    }
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
      setExtraRequestParameterRows(extraRequestParameterDrafts(nextModel));
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
    setExtraRequestParameterRows(extraRequestParameterDrafts(nextModel));
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

  function renderSensitiveDataTestPanel() {
    const evaluationResults = new Map((sensitiveDataEvaluationRun?.results || []).map((item) => [item.id, item]));
    const selectedEvaluationCase = sensitiveDataEvaluationCases.find((item) => item.id === selectedSensitiveDataEvaluationCaseId)
      || sensitiveDataEvaluationCases[0];
    const selectedEvaluationIndex = selectedEvaluationCase
      ? sensitiveDataEvaluationCases.findIndex((item) => item.id === selectedEvaluationCase.id)
      : -1;
    const selectedEvaluationValues = selectedEvaluationCase
      ? selectedEvaluationCase.expectedValuesText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      : [];
    const selectedEvaluationGroups = selectedEvaluationCase
      ? groupedSensitiveValues(selectedEvaluationCase.text, selectedEvaluationValues)
      : [];
    const selectedEvaluationResult = selectedEvaluationCase ? evaluationResults.get(selectedEvaluationCase.id) : undefined;
    const selectedEvaluationRecall = selectedEvaluationValues.length
      ? Math.round(((selectedEvaluationValues.length - (selectedEvaluationResult?.missingValues.length || 0)) / selectedEvaluationValues.length) * 100)
      : 0;
    const visibleEvaluationCases = sensitiveDataEvaluationCases.filter((item, index) => (
      evaluationCaseDisplayName(item.name, index).toLocaleLowerCase().includes(sensitiveDataEvaluationSearch.trim().toLocaleLowerCase())
    ));
    return (
      <div className="settings-sensitive-data-test">
        <div className="settings-sensitive-data-test-head">
          <div>
            <h3>{t('敏感数据过滤测试')}</h3>
            <span>{t('使用当前已保存的 GLiNER 配置测试文本脱敏；测试不会调用任何 AI 模型，也不会保存输入和结果。')}</span>
          </div>
          <button
            className="ui-button ui-button--primary"
            disabled={testingSensitiveData || !sensitiveDataTestInput.trim()}
            onClick={runSensitiveDataTest}
            type="button"
          >
            {testingSensitiveData ? <Loader2 className="spin" size={15} /> : null}
            {t(testingSensitiveData ? '正在检测' : '开始检测')}
          </button>
        </div>
        <div className="settings-sensitive-data-test-grid">
          <label className="settings-sensitive-data-test-field">
            <strong>{t('待检测文本')}</strong>
            <TextArea
              className="settings-sensitive-data-test-input"
              fullWidth
              placeholder={t('例如：张三的邮箱是 zhangsan@example.com，手机号是 13800138000。')}
              value={sensitiveDataTestInput}
              onChange={(event) => {
                setSensitiveDataTestInput(event.target.value);
                setSensitiveDataTestResult(null);
                setSensitiveDataTestError('');
              }}
            />
          </label>
          <div className="settings-sensitive-data-test-field">
            <strong>{t('脱敏结果')}</strong>
            <pre aria-live="polite" className={`settings-sensitive-data-test-output${sensitiveDataTestResult ? ' has-result' : ''}`}>
              {sensitiveDataTestResult?.text || t('检测完成后在此显示结果。')}
            </pre>
          </div>
        </div>
        {sensitiveDataTestError ? (
          <div className="settings-sensitive-data-test-error" role="alert">{sensitiveDataTestError}</div>
        ) : null}
        {sensitiveDataTestResult ? (
          <div className="settings-sensitive-data-replacements">
            <div className="settings-sensitive-data-replacements-head">
              <strong>{t('替换明细')}</strong>
              <span>{t('{count} 项', { count: sensitiveDataTestResult.replacements.length })}</span>
            </div>
            {sensitiveDataTestResult.replacements.length ? (
              <div className="settings-sensitive-data-replacement-list">
                {sensitiveDataTestResult.replacements.map((replacement, index) => (
                  <div className="settings-sensitive-data-replacement-row" key={`${replacement.start}:${replacement.end}:${index}`}>
                    <code>{replacement.original}</code>
                    <span aria-hidden="true">→</span>
                    <code>{replacement.placeholder}</code>
                    <span className="settings-sensitive-data-label">{replacement.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-sensitive-data-test-empty">{t('未检测到敏感内容。')}</div>
            )}
          </div>
        ) : null}
        <div className={`settings-sensitive-data-evaluation-workbench${sensitiveDataEvaluationExpanded ? ' is-expanded' : ''}`}>
          <header className="evaluation-workbench-head">
            <div className="evaluation-workbench-title">
              <h3>{t('脱敏评测集')}</h3>
              <span>{t('配置可复用用例并批量评测。每个预期敏感原文单独占一行，系统按原文精确匹配统计通过率、精确率和召回率。')}</span>
            </div>
            <div className="evaluation-workbench-actions">
              <button disabled={savingSensitiveDataEvaluation || loadingSensitiveDataEvaluation} onClick={saveSensitiveDataEvaluationCases} type="button">
                {savingSensitiveDataEvaluation ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                {t('保存评测集')}
              </button>
              <button disabled={runningSensitiveDataEvaluation || loadingSensitiveDataEvaluation || !sensitiveDataEvaluationCases.length} onClick={runSensitiveDataEvaluation} type="button">
                {runningSensitiveDataEvaluation ? <Loader2 className="spin" size={16} /> : <PlayCircle size={16} />}
                {t(runningSensitiveDataEvaluation ? '正在评测' : '运行评测')}
              </button>
              <button className="primary" data-slot="evaluation-primary-action" onClick={addSensitiveDataEvaluationCase} type="button">
                <Plus size={17} />
                {t('新增用例')}
              </button>
            </div>
          </header>
          {sensitiveDataEvaluationError ? <div className="settings-sensitive-data-test-error" role="alert">{sensitiveDataEvaluationError}</div> : null}
          {loadingSensitiveDataEvaluation ? (
            <div className="settings-sensitive-data-test-empty"><Loader2 className="spin" size={16} /> {t('正在读取评测集')}</div>
          ) : selectedEvaluationCase ? (
            <div className="evaluation-workbench-shell">
              <aside className="evaluation-case-sidebar">
                <div className="evaluation-case-sidebar-head">
                  <strong>{t('用例列表')}</strong>
                  <div>
                    <button aria-label={t('新增用例')} onClick={addSensitiveDataEvaluationCase} type="button"><Plus size={18} /></button>
                  </div>
                </div>
                <label className="evaluation-case-search">
                  <Search aria-hidden="true" size={16} />
                  <input onChange={(event) => setSensitiveDataEvaluationSearch(event.target.value)} placeholder={t('搜索用例')} value={sensitiveDataEvaluationSearch} />
                </label>
                <div className="evaluation-case-list">
                  {visibleEvaluationCases.map((item) => {
                    const index = sensitiveDataEvaluationCases.findIndex((entry) => entry.id === item.id);
                    const result = evaluationResults.get(item.id);
                    const count = item.expectedValuesText.split(/\r?\n/).filter((value) => value.trim()).length;
                    return (
                      <div className={`evaluation-case-row${item.id === selectedEvaluationCase.id ? ' is-active' : ''}`} key={item.id}>
                        <button className="evaluation-case-select" onClick={() => setSelectedSensitiveDataEvaluationCaseId(item.id)} type="button">
                          <span className="case-index">{String(index + 1).padStart(2, '0')}</span>
                          <span className="case-name">{evaluationCaseDisplayName(item.name, index)}</span>
                          {result ? result.passed ? <CircleCheck className="case-pass" size={15} /> : <AlertCircle className="case-fail" size={15} /> : <span className="case-pending" />}
                          <span className="case-count">{count}</span>
                        </button>
                        <button className="evaluation-case-delete" aria-label={t('删除用例')} onClick={() => removeSensitiveDataEvaluationCase(item.id)} title={t('删除用例')} type="button"><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                </div>
              </aside>
              <section className="evaluation-editor-pane">
                <div className="evaluation-editor-toolbar">
                  <input aria-label={t('用例名称')} className="evaluation-case-name-input" onChange={(event) => updateSensitiveDataEvaluationCase(selectedEvaluationCase.id, { name: event.target.value })} value={evaluationCaseDisplayName(selectedEvaluationCase.name, selectedEvaluationIndex)} />
                  <div>
                    <button aria-label={t('复制')} onClick={() => void navigator.clipboard?.writeText(selectedEvaluationCase.text)} type="button"><Copy size={16} /></button>
                    <button aria-label={t('全屏')} onClick={() => setSensitiveDataEvaluationExpanded((current) => !current)} type="button"><Maximize2 size={16} /></button>
                  </div>
                </div>
                <div className="evaluation-text-editor">
                  <div className="evaluation-line-numbers" aria-hidden="true">
                    {Array.from({ length: Math.max(15, selectedEvaluationCase.text.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}
                  </div>
                  <div className="evaluation-editor-content">
                    <pre aria-hidden="true">{highlightedSensitiveText(selectedEvaluationCase.text, selectedEvaluationValues)}</pre>
                    <textarea onChange={(event) => updateSensitiveDataEvaluationCase(selectedEvaluationCase.id, { text: event.target.value })} placeholder={t('输入包含合成敏感数据的测试文本。')} spellCheck={false} value={selectedEvaluationCase.text} />
                  </div>
                </div>
              </section>
              <aside className="evaluation-inspector-pane">
                <div className="evaluation-inspector-tabs">
                  <button className={sensitiveDataEvaluationPanelTab === 'expected' ? 'is-active' : ''} onClick={() => setSensitiveDataEvaluationPanelTab('expected')} type="button">{t('预期敏感原文')}</button>
                  <button className={sensitiveDataEvaluationPanelTab === 'result' ? 'is-active' : ''} onClick={() => setSensitiveDataEvaluationPanelTab('result')} type="button">{t('检测结果')}</button>
                </div>
                {sensitiveDataEvaluationPanelTab === 'expected' ? (
                  <div className="evaluation-inspector-content">
                    <form className="evaluation-expected-add" onSubmit={(event) => { event.preventDefault(); addSensitiveDataEvaluationExpectedValue(selectedEvaluationCase.id); }}>
                      <input aria-label={t('预期敏感原文')} onChange={(event) => setSensitiveDataEvaluationNewExpectedValue(event.target.value)} placeholder={t('输入预期敏感原文')} value={sensitiveDataEvaluationNewExpectedValue} />
                      <button disabled={!sensitiveDataEvaluationNewExpectedValue.trim()} type="submit"><Plus size={15} />{t('添加')}</button>
                    </form>
                    <p className="evaluation-expected-help">{t('预期敏感原文是评测标准答案，用于计算漏检、误报、精确率和召回率。')}</p>
                    <div className="evaluation-inspector-count">{t('共 {count} 项', { count: selectedEvaluationValues.length })}</div>
                    {selectedEvaluationGroups.map((group) => {
                      const collapsed = collapsedSensitiveDataGroups.has(`${selectedEvaluationCase.id}:${group.id}`);
                      return (
                        <section className={`evaluation-value-group group-${group.id}${collapsed ? ' is-collapsed' : ''}`} key={group.id}>
                          <button className="evaluation-value-group-head" onClick={() => toggleSensitiveDataEvaluationGroup(selectedEvaluationCase.id, group.id)} type="button"><SensitiveValueGroupIcon id={group.id} /><strong>{group.label}</strong><span>{group.items.length}</span><ChevronDown size={15} /></button>
                          {collapsed ? null : (
                            <div className="evaluation-value-chips">
                              {group.items.map((value) => <span key={value}>{value}<button aria-label={t('删除 {value}', { value })} onClick={() => removeSensitiveDataEvaluationExpectedValue(selectedEvaluationCase.id, value)} type="button"><X size={12} /></button></span>)}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                ) : (
                  <div className="evaluation-result-panel">
                    {selectedEvaluationResult ? (
                      <>
                        <pre>{selectedEvaluationResult.text}</pre>
                        <div className="result-finding result-missing"><strong>{t('漏检')}</strong>{selectedEvaluationResult.missingValues.length ? selectedEvaluationResult.missingValues.map((value) => <span key={value}>{value}</span>) : <em>{t('无')}</em>}</div>
                        <div className="result-finding result-unexpected"><strong>{t('误报')}</strong>{selectedEvaluationResult.unexpectedValues.length ? selectedEvaluationResult.unexpectedValues.map((value) => <span key={value}>{value}</span>) : <em>{t('无')}</em>}</div>
                      </>
                    ) : <div className="evaluation-result-empty">{t('运行评测后查看检测结果。')}</div>}
                  </div>
                )}
              </aside>
              <footer className="evaluation-status-bar" aria-live="polite">
                <span className="detected"><CircleCheck size={15} />{t('已检测')} <strong>{selectedEvaluationResult?.detectedValues.length || 0}</strong></span>
                <span className="missing"><AlertCircle size={15} />{t('漏检')} <strong>{selectedEvaluationResult?.missingValues.length || 0}</strong></span>
                <span className="unexpected"><AlertCircle size={15} />{t('误报')} <strong>{selectedEvaluationResult?.unexpectedValues.length || 0}</strong></span>
                <span>{t('召回率')} <strong>{selectedEvaluationResult ? `${selectedEvaluationRecall}%` : '—'}</strong></span>
              </footer>
            </div>
          ) : (
            <div className="settings-sensitive-data-test-empty">{t('暂无评测用例，点击“新增用例”开始配置。')}</div>
          )}
        </div>
      </div>
    );
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
            className="settings-textarea-control"
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
        dialogClassName="ui-modal ui-modal--form ui-modal--personal-memory"
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
  const activeProviderEnabled = activeProviderSettings.enabled === true;
  const activeProviderSupportsExtraRequestParameters = activeProvider === 'minimax' || activeProvider.startsWith('openai-compatible');
  const activeProviderExtraRequestParameterRows = extraRequestParameterRows[activeProvider] || [];
  const activeProviderDuplicateExtraRequestParameterKeys = duplicateExtraRequestParameterKeys(activeProviderExtraRequestParameterRows);
  const visibleEnvItems = items
    .map((item, index) => ({ item, index, definition: runtimeEnvDefinition(item.key) }))
    .filter(({ definition }) => activeTab !== 'general' && activeTab !== 'model' && activeTab !== 'skills' && activeTab !== 'memory' && activeTab !== 'accounts' && definition?.tab === activeTab);
  const visibleEnvGroups = groupVisibleEnvSettings(activeTab, visibleEnvItems);

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
            <span>{t('模型、浏览器、敏感数据过滤、运行控制和调试参数全部在网页配置中管理。')}</span>
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
                <span>{t('正在加载模型、浏览器、敏感数据过滤、运行控制和调试参数。')}</span>
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
              <SettingsGroupCard title={t('基础设置')}>
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
              </SettingsGroupCard>
            </section>
          ) : null}

          {activeTab === 'model' ? (
            <section className="settings-model-section">
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
              <div className="settings-group-stack settings-model-card">
                <SettingsGroupCard className="settings-model-group" title={t('基础信息')}>
                <div className="settings-row">
                  <div>
                    <strong>{t('模型供应商')}</strong>
                    <span>{t('选择要查看和编辑的模型服务供应商。')}</span>
                  </div>
                  <CustomSelect
                    className="settings-control"
                    value={activeProvider}
                    onChange={(nextValue) => selectProvider(nextValue as ModelProvider)}
                    options={modelProviderDefinitions.map((provider) => ({
                      label: editingModelConfig.providers?.[provider.value]?.displayName?.trim() || t(provider.label),
                      value: provider.value,
                    }))}
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>{t('供应商名称')}</strong>
                    <span>{t('用于模型选择器中的分组名称，可按实际接入服务自由修改。')}</span>
                  </div>
                  <AppInput
                    maxLength={80}
                    onChange={(event) => updateActiveProviderSettings({ displayName: event.target.value })}
                    placeholder={t(activeProviderOption.label)}
                    value={activeProviderSettings.displayName || ''}
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
                <div className="settings-row settings-add-compatible-provider-row">
                  <div>
                    <strong>{t('OpenAI 兼容 API')}</strong>
                    <span>{t('新增一个可独立配置名称、Base URL、访问密钥和模型列表的供应商。')}</span>
                  </div>
                  <button className="ui-button" onClick={addOpenAICompatibleProvider} type="button">
                    <Plus size={15} />
                    {t('添加兼容供应商')}
                  </button>
                </div>
                </SettingsGroupCard>
                <SettingsGroupCard className="settings-model-group" title={t('模型列表')}>
                <div className="settings-row settings-model-list-row">
                  <div>
                    <span>{t('一个服务商可以维护多个模型，运行时可在下拉框里按服务商分组选择。')}</span>
                  </div>
                  <div className="settings-model-list-control">
                    {activeProviderModels.map((model, index) => (
                      <div className="settings-model-input-row" key={`${activeProvider}-${index}`}>
                        <AppInput
                          disabled={!activeProviderEnabled}
                          prefix={<span className="settings-model-icon"><ModelBrandIcon model={model} provider={activeProvider} /></span>}
                          value={model}
                          onChange={(event) => updateActiveProviderModel(index, event.target.value)}
                          placeholder={t('模型名称')}
                          suffix={(
                            <button
                              aria-label={t('图片输入')}
                              aria-pressed={activeProviderSettings.modelCapabilities?.[model]?.imageInput === true}
                              className={`settings-model-capability-button${activeProviderSettings.modelCapabilities?.[model]?.imageInput === true ? ' on' : ''}`}
                              disabled={!activeProviderEnabled || !model.trim()}
                              onClick={() => setActiveModelImageInput(model, activeProviderSettings.modelCapabilities?.[model]?.imageInput !== true)}
                              title={t(activeProviderSettings.modelCapabilities?.[model]?.imageInput === true ? '支持图片输入' : '不支持图片输入')}
                              type="button"
                            >
                              <ImageIcon aria-hidden="true" size={16} strokeWidth={1.9} />
                            </button>
                          )}
                        />
                        <button
                          aria-label={t('删除模型')}
                          className="settings-model-row-button danger"
                          disabled={!activeProviderEnabled}
                          onClick={() => removeActiveProviderModel(index)}
                          title={t('删除模型')}
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
                </SettingsGroupCard>
                <SettingsGroupCard className="settings-model-group" initiallyOpen={false} title={t('连接配置')}>
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
                      <span>{t(activeProvider.startsWith('openai-compatible')
                        ? '填写服务商提供的 OpenAI 兼容 Base URL，通常以 /v1 结尾。'
                        : '自定义兼容服务地址，留空使用默认地址。')}</span>
                    </div>
                    <AppInput value={activeProviderSettings.baseURL || ''} onChange={(event) => updateActiveProviderSettings({ baseURL: event.target.value })} placeholder={activeProviderOption.defaultBaseURL || t('默认地址')} />
                  </div>
                ) : null}
                {activeProviderSupportsExtraRequestParameters ? (
                  <div className="settings-row settings-extra-parameters-row">
                    <div>
                      <strong>{t('额外请求参数')}</strong>
                      <span>{t('以键值对形式添加到每次 Chat Completions 请求。值支持布尔值、数字、JSON 对象、数组和字符串；model、messages、stream、tools、tool_choice 由应用管理。')}</span>
                    </div>
                    <div className="settings-extra-parameters-control">
                      {activeProviderExtraRequestParameterRows.length ? (
                        <div className="settings-extra-parameters-list">
                          {activeProviderExtraRequestParameterRows.map((row) => (
                            <div className="settings-extra-parameter-input-row" key={row.id}>
                              <AppInput
                                aria-invalid={activeProviderDuplicateExtraRequestParameterKeys.includes(row.key.trim()) || undefined}
                                aria-label={t('参数名')}
                                onChange={(event) => updateActiveProviderExtraRequestParameter(row.id, { key: event.target.value })}
                                placeholder={t('参数名')}
                                value={row.key}
                              />
                              <AppInput
                                aria-label={t('参数值')}
                                onChange={(event) => updateActiveProviderExtraRequestParameter(row.id, { value: event.target.value })}
                                placeholder={t('参数值，例如 true、0.2、"priority" 或 {"type":"adaptive"}')}
                                value={row.value}
                              />
                              <button
                                aria-label={t('删除参数')}
                                className="settings-model-row-button danger"
                                onClick={() => removeActiveProviderExtraRequestParameter(row.id)}
                                title={t('删除参数')}
                                type="button"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="settings-extra-parameters-empty">{t('暂未添加额外请求参数。')}</span>
                      )}
                      {activeProviderDuplicateExtraRequestParameterKeys.length ? (
                        <span className="settings-extra-parameters-error" role="alert">
                          {t('额外请求参数名不能重复：{keys}', { keys: activeProviderDuplicateExtraRequestParameterKeys.join(', ') })}
                        </span>
                      ) : null}
                      <button className="ui-button settings-add-parameter-button" onClick={addActiveProviderExtraRequestParameter} type="button">
                        <Plus size={15} />
                        {t('添加参数')}
                      </button>
                    </div>
                  </div>
                ) : null}
                </SettingsGroupCard>
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
                <div className="settings-group-stack">
                  {visibleEnvGroups.map((group, groupIndex) => (
                    <SettingsGroupCard initiallyOpen={groupIndex < 2} key={group.title} title={t(group.title)}>
                      {group.items.map(({ item, index, definition }) => (
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
                    </SettingsGroupCard>
                  ))}
                </div>
              ) : (
                <div className="empty-state">{t('这个分类暂无配置。')}</div>
              )}
              {activeTab === 'sensitive-data' ? renderSensitiveDataTestPanel() : null}
            </section>
          ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
