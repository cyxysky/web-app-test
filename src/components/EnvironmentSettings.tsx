'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, FolderOpen, Loader2, Save } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import {
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

type EnvRow = Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'> & {
  updatedAt?: string;
};

type ModelConfig = Pick<ModelConfigRecord, 'provider' | 'providers' | 'updatedAt'>;

type SystemBridge = {
  selectDirectory: (input?: { defaultPath?: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
};

declare global {
  interface Window {
    webPilotSystem?: SystemBridge;
  }
}

export const environmentSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用设置' },
  { id: 'model', label: '模型配置' },
  { id: 'browser', label: '浏览器与截图' },
  { id: 'runtime', label: '运行控制' },
  { id: 'debug', label: '调试与高级' },
];

function createModelConfig(input?: Partial<ModelConfig>): ModelConfig {
  const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const definition of modelProviderDefinitions) {
    const current = input?.providers?.[definition.value];
    providers[definition.value] = {
      model: current?.model || definition.defaultModel,
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
    model: definition.defaultModel,
    apiKey: '',
    baseURL: definition.defaultBaseURL || '',
  };
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
  onRuntimeEnvSaved,
  showTabs = true,
}: {
  activeTab?: SettingsTab;
  embedded?: boolean;
  onActiveTabChange?: (tab: SettingsTab) => void;
  onRuntimeEnvSaved?: () => void;
  showTabs?: boolean;
} = {}) {
  const { language, setLanguage, t } = useI18n();
  const { color, currentColor, scrollbarColor, setColor, setScrollbarColor } = useTheme();
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>('general');
  const [items, setItems] = useState<EnvRow[]>([]);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(() => createModelConfig());
  const [modelDraft, setModelDraft] = useState<ModelConfig>(() => createModelConfig());
  const [loading, setLoading] = useState(true);
  const [savingEnv, setSavingEnv] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
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

  async function load() {
    setLoading(true);
    try {
      const [envResponse, modelResponse] = await Promise.all([
        fetch('/api/settings/env', { cache: 'no-store' }),
        fetch('/api/settings/model', { cache: 'no-store' }),
      ]);
      const envData = await envResponse.json();
      const modelData = await modelResponse.json();
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('保存环境配置失败'));
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
      const next = createModelConfig(current);
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('保存模型配置失败'));
      const nextModel = createModelConfig(data.config);
      setModelConfig(nextModel);
      setModelDraft(nextModel);
    } finally {
      setSavingModel(false);
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
            className="settings-picker-button"
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

  const editingModelConfig = createModelConfig(modelDraft || modelConfig);
  const activeProvider = editingModelConfig.provider;
  const activeProviderOption = modelProviderDefinition(activeProvider);
  const activeProviderSettings = providerSettings(editingModelConfig, activeProvider);
  const visibleEnvItems = items
    .map((item, index) => ({ item, index, definition: runtimeEnvDefinition(item.key) }))
    .filter(({ definition }) => activeTab !== 'general' && activeTab !== 'model' && definition?.tab === activeTab);

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
                <button className="settings-save-button" disabled={savingModel || loading} onClick={saveModel} type="button">
                  {savingModel ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                  {t('保存')}
                </button>
              </div>
              <div className="settings-card">
                <div className="settings-row">
                  <div>
                    <strong>{t('服务商')}</strong>
                    <span>{t('选择当前运行使用的 AI 模型服务提供商。')}</span>
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
                    <strong>{t('模型名称')}</strong>
                    <span>{t('仅作用于当前选中的服务商。')}</span>
                  </div>
                  <input className="input settings-control" value={activeProviderSettings.model} onChange={(event) => updateActiveProviderSettings({ model: event.target.value })} placeholder={activeProviderOption.defaultModel} />
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

          {activeTab !== 'general' && activeTab !== 'model' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>{t(environmentSettingsTabs.find((tab) => tab.id === activeTab)?.label || '')}</h2>
                  <span>{t('{count} 项网页配置', { count: visibleEnvItems.length })}</span>
                </div>
                <button className="settings-save-button" disabled={savingEnv || loading} onClick={saveEnv} type="button">
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
