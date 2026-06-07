'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Save } from 'lucide-react';
import {
  modelProviderDefinitions,
  modelProviderDefinition,
  runtimeEnvDefinition,
  type SettingsTab,
} from '@/config/settings';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { ModelConfigRecord, ModelProvider, ModelProviderSettings, RuntimeEnvRecord } from '@/server/ai/schemas/test-case.schema';

type EnvRow = Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'> & {
  updatedAt?: string;
};

type ModelConfig = Pick<ModelConfigRecord, 'provider' | 'providers' | 'updatedAt'>;

export const environmentSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
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

export function EnvironmentSettings({
  activeTab: controlledActiveTab,
  embedded = false,
  onActiveTabChange,
  showTabs = true,
}: {
  activeTab?: SettingsTab;
  embedded?: boolean;
  onActiveTabChange?: (tab: SettingsTab) => void;
  showTabs?: boolean;
} = {}) {
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>('model');
  const [items, setItems] = useState<EnvRow[]>([]);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(() => createModelConfig());
  const [modelDraft, setModelDraft] = useState<ModelConfig>(() => createModelConfig());
  const [loading, setLoading] = useState(true);
  const [savingEnv, setSavingEnv] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const activeTab = controlledActiveTab || internalActiveTab;
  const selectTab = onActiveTabChange || setInternalActiveTab;

  useEffect(() => {
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

  async function saveEnv() {
    setSavingEnv(true);
    startGlobalLoading('正在保存环境配置');
    try {
      const response = await fetch('/api/settings/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map((item) => ({ ...item, enabled: true, secret: isSecret(item) })) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存环境配置失败');
      setItems(data.saved || []);
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
    startGlobalLoading('正在保存模型配置');
    try {
      const response = await fetch('/api/settings/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存模型配置失败');
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
        <select className="input settings-control" value={item.value} onChange={(event) => update(index, { value: event.target.value })}>
          {(definition.options || []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      );
    }

    return (
      <input
        className="input settings-control"
        inputMode={definition?.control === 'number' ? 'decimal' : undefined}
        placeholder="未设置"
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
    .filter(({ definition }) => definition?.tab === activeTab);

  return (
    <main className={embedded ? 'settings-workspace embedded' : 'settings-workspace'}>
      {embedded ? null : (
        <header className="settings-header">
          <Link className="ghost-link" href="/dashboard">
            <ArrowLeft size={15} />
            返回工作台
          </Link>
          <div>
            <h1>环境配置</h1>
            <span>模型、浏览器、运行控制和调试参数全部在网页配置中管理。</span>
          </div>
        </header>
      )}

      <div className={showTabs ? 'settings-layout' : 'settings-layout no-tabs'}>
        {showTabs ? (
          <nav className="settings-tabs" aria-label="环境配置分类">
            {environmentSettingsTabs.map((tab) => (
              <button className={activeTab === tab.id ? 'active' : undefined} key={tab.id} onClick={() => selectTab(tab.id)} type="button">
                {tab.label}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="settings-content">
          {loading ? (
            <section className="settings-loading-panel" role="status" aria-live="polite">
              <Loader2 className="spin" size={18} />
              <div>
                <h2>正在读取环境配置</h2>
                <span>正在加载模型、浏览器、运行控制和调试参数。</span>
              </div>
            </section>
          ) : (
            <>
          {activeTab === 'model' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>模型配置</h2>
                  <span>每个服务商独立保存模型、Key 和 Base URL，切换服务商不会串用密钥。</span>
                </div>
                <button className="settings-save-button" disabled={savingModel || loading} onClick={saveModel} type="button">
                  {savingModel ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                  保存
                </button>
              </div>
              <div className="settings-card">
                <div className="settings-row">
                  <div>
                    <strong>服务商</strong>
                    <span>选择当前运行使用的 AI 模型服务提供商。</span>
                  </div>
                  <select className="input settings-control" value={activeProvider} onChange={(event) => selectProvider(event.target.value as ModelProvider)}>
                    {modelProviderDefinitions.map((provider) => (
                      <option key={provider.value} value={provider.value}>{provider.label}</option>
                    ))}
                  </select>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>模型名称</strong>
                    <span>仅作用于当前选中的服务商。</span>
                  </div>
                  <input className="input settings-control" value={activeProviderSettings.model} onChange={(event) => updateActiveProviderSettings({ model: event.target.value })} placeholder={activeProviderOption.defaultModel} />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>访问密钥</strong>
                    <span>{activeProviderOption.keyLabel}</span>
                  </div>
                  <input
                    className="input settings-control"
                    disabled={Boolean(activeProviderOption.localAuth)}
                    type="password"
                    value={activeProviderSettings.apiKey || ''}
                    onChange={(event) => updateActiveProviderSettings({ apiKey: event.target.value })}
                    placeholder={activeProviderOption.localAuth ? '本地登录，无需 Key' : '填写该服务商的访问密钥'}
                  />
                </div>
                {activeProviderOption.baseUrlLabel ? (
                  <div className="settings-row">
                    <div>
                      <strong>{activeProviderOption.baseUrlLabel}</strong>
                      <span>自定义兼容服务地址，留空使用默认地址。</span>
                    </div>
                    <input className="input settings-control" value={activeProviderSettings.baseURL || ''} onChange={(event) => updateActiveProviderSettings({ baseURL: event.target.value })} placeholder={activeProviderOption.defaultBaseURL || '默认地址'} />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeTab !== 'model' ? (
            <section>
              <div className="settings-section-head">
                <div>
                  <h2>{environmentSettingsTabs.find((tab) => tab.id === activeTab)?.label}</h2>
                  <span>{visibleEnvItems.length} 项网页配置</span>
                </div>
                <button className="settings-save-button" disabled={savingEnv || loading} onClick={saveEnv} type="button">
                  {savingEnv ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                  保存
                </button>
              </div>
              {visibleEnvItems.length ? (
                <div className="settings-card">
                  {visibleEnvItems.map(({ item, index, definition }) => (
                    <div className="settings-row settings-env-row" key={item.key}>
                      <div className="env-name" title={item.key}>
                        <strong>{definition?.label || item.key}</strong>
                        <span>{definition?.description || '网页配置项。'}</span>
                      </div>
                      <div className="settings-row-control">
                        {renderRuntimeControl(item, index)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">这个分类暂无配置。</div>
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
