'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Database, Download, Loader2, RefreshCw, RotateCcw, Save, Upload } from 'lucide-react';
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

type StorageHealth = {
  activeProvider: string;
  activeStore: string;
  database: {
    path: string;
    url: string;
    exists: boolean;
    file?: {
      path: string;
      bytes: number;
      updatedAt: string;
    };
    sizeBytes?: number;
    lastWriteAt?: string;
    recordCounts: Record<string, number>;
  };
  schema: {
    currentVersion: number;
    expectedVersion: number;
    migrations: Array<{
      version: number;
      name: string;
      appliedAt: string;
      details?: unknown;
    }>;
  };
  backups: {
    directory: string;
    count: number;
    latest?: {
      name: string;
      path: string;
      bytes: number;
      createdAt: string;
      updatedAt: string;
    };
    items: Array<{
      name: string;
      path: string;
      bytes: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  artifacts: {
    root: string;
    policy: string;
  };
  prisma: {
    schemaPath: string;
    schemaExists: boolean;
    cliPath?: string;
    cliAvailable: boolean;
  };
  runtime: {
    state: string;
    message: string;
    nextActions: string[];
  };
};

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
  if (item.key === 'SQLITE_DATABASE_URL') return false;
  return Boolean(item.secret || runtimeEnvDefinition(item.key)?.secret || /KEY|TOKEN|SECRET|PASSWORD|COOKIE|DATABASE_URL/i.test(item.key));
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value?: string) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function downloadFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileNameFromDisposition(value: string | null) {
  const match = value?.match(/filename="?([^";]+)"?/i);
  return match?.[1] || `ai-web-test-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

function StorageHealthPanel() {
  const [health, setHealth] = useState<StorageHealth | undefined>();
  const [busy, setBusy] = useState<'refresh' | 'initialize' | 'backup' | 'restore' | 'export' | 'import' | undefined>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const counts = health?.database.recordCounts || {};

  async function loadStorageHealth(mode: typeof busy = 'refresh') {
    setBusy(mode);
    setError('');
    try {
      const response = await fetch('/api/storage/status', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取存储状态失败');
      setHealth(data as StorageHealth);
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : '读取存储状态失败');
    } finally {
      setBusy(undefined);
    }
  }

  async function postStorageAction(action: 'initialize' | 'backup' | 'restore') {
    const labels = {
      initialize: '正在初始化 SQLite',
      backup: '正在创建数据库备份',
      restore: '正在恢复最近备份',
    };
    const endpoints = {
      initialize: '/api/storage/sqlite/initialize',
      backup: '/api/storage/sqlite/backup',
      restore: '/api/storage/sqlite/restore',
    };
    const label = labels[action];
    if (action === 'restore' && !window.confirm('恢复最近备份会覆盖当前 SQLite 数据库，恢复前会自动创建安全备份。继续？')) {
      return;
    }
    setBusy(action);
    setError('');
    setNotice('');
    startGlobalLoading(label);
    try {
      const response = await fetch(
        endpoints[action],
        { method: 'POST' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || label);
      setHealth((data.health || health) as StorageHealth | undefined);
      if (action === 'backup') setNotice(`已创建备份：${data.backup?.name || '完成'}`);
      if (action === 'restore') setNotice(`已恢复备份：${data.restored?.name || '最近备份'}`);
      if (action === 'initialize') setNotice('SQLite schema 已确认可用。');
      if (!data.health) await loadStorageHealth(action);
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : label);
    } finally {
      setBusy(undefined);
      stopGlobalLoading();
    }
  }

  async function exportStorageData() {
    const label = '正在导出运行时数据';
    setBusy('export');
    setError('');
    setNotice('');
    startGlobalLoading(label);
    try {
      const response = await fetch('/api/storage/sqlite/export', { cache: 'no-store' });
      const blob = await response.blob();
      if (!response.ok) {
        const text = await blob.text().catch(() => '');
        throw new Error(text || '导出运行时数据失败');
      }
      downloadFile(blob, fileNameFromDisposition(response.headers.get('Content-Disposition')));
      setNotice('运行时数据已导出为 JSON。');
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : label);
    } finally {
      setBusy(undefined);
      stopGlobalLoading();
    }
  }

  async function importStorageData(file?: File) {
    if (!file) return;
    if (!window.confirm('导入会覆盖当前测试数据；导入前会自动创建安全备份。继续？')) {
      if (importInputRef.current) importInputRef.current.value = '';
      return;
    }
    const label = '正在导入运行时数据';
    setBusy('import');
    setError('');
    setNotice('');
    startGlobalLoading(label);
    try {
      const text = await file.text();
      const response = await fetch('/api/storage/sqlite/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '导入运行时数据失败');
      setHealth((data.health || health) as StorageHealth | undefined);
      setNotice(`已导入数据，安全备份：${data.safetyBackup?.name || '已创建'}`);
      if (!data.health) await loadStorageHealth('import');
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : label);
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
      setBusy(undefined);
      stopGlobalLoading();
    }
  }

  useEffect(() => {
    void loadStorageHealth();
  }, []);

  return (
    <section className="storage-health-panel">
      <div className="settings-section-head compact">
        <div>
          <h2>存储健康</h2>
          <span>SQLite 是当前运行时唯一数据源，测试数据与浏览器对话会话都写入本地数据库。</span>
        </div>
        <div className="storage-action-row">
          <button className="settings-save-button secondary" disabled={Boolean(busy)} onClick={() => loadStorageHealth()} type="button">
            {busy === 'refresh' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            刷新
          </button>
          <button className="settings-save-button secondary" disabled={Boolean(busy)} onClick={() => postStorageAction('initialize')} type="button">
            {busy === 'initialize' ? <Loader2 className="spin" size={15} /> : <Database size={15} />}
            初始化 SQLite
          </button>
          <button className="settings-save-button secondary" disabled={Boolean(busy)} onClick={() => postStorageAction('backup')} type="button">
            {busy === 'backup' ? <Loader2 className="spin" size={15} /> : <Database size={15} />}
            备份
          </button>
          <button className="settings-save-button secondary" disabled={Boolean(busy) || !health?.backups.latest} onClick={() => postStorageAction('restore')} type="button">
            {busy === 'restore' ? <Loader2 className="spin" size={15} /> : <RotateCcw size={15} />}
            恢复最近备份
          </button>
          <button className="settings-save-button secondary" disabled={Boolean(busy)} onClick={exportStorageData} type="button">
            {busy === 'export' ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
            导出
          </button>
          <button className="settings-save-button secondary" disabled={Boolean(busy)} onClick={() => importInputRef.current?.click()} type="button">
            {busy === 'import' ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
            导入
          </button>
          <input
            ref={importInputRef}
            className="storage-import-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void importStorageData(event.currentTarget.files?.[0])}
          />
        </div>
      </div>
      <div className="storage-health-grid">
        <div>
          <strong>当前后端</strong>
          <span>{health?.activeProvider || 'sqlite'} / {health?.activeStore || 'sqlite-prisma-raw'}</span>
        </div>
        <div>
          <strong>数据库记录</strong>
          <span>{counts.testCases || 0} 用例 · {counts.runs || 0} 运行 · {counts.browserChatSessions || 0} 对话 · {counts.siteKnowledge || 0} 站点知识</span>
        </div>
        <div>
          <strong>SQLite 文件</strong>
          <span>{health?.database.exists ? `${formatBytes(health.database.sizeBytes)} · ${formatDate(health.database.lastWriteAt)}` : '未初始化'}</span>
        </div>
        <div>
          <strong>Schema 版本</strong>
          <span>v{health?.schema.currentVersion ?? 0} / v{health?.schema.expectedVersion ?? 0}</span>
        </div>
        <div>
          <strong>备份状态</strong>
          <span>{health?.backups.count || 0} 个备份 · 最近 {formatDate(health?.backups.latest?.updatedAt)}</span>
        </div>
        <div>
          <strong>Prisma 资源</strong>
          <span>schema {health?.prisma.schemaExists ? 'ok' : 'missing'} · cli {health?.prisma.cliAvailable ? 'ok' : 'missing'}</span>
        </div>
      </div>
      {health ? (
        <div className="storage-health-detail">
          <p>{health.runtime.message}</p>
          <dl>
            <div>
              <dt>SQLite</dt>
              <dd>{health.database.path}</dd>
            </div>
            <div>
              <dt>备份目录</dt>
              <dd>{health.backups.directory}</dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd>{health.prisma.schemaPath}</dd>
            </div>
            <div>
              <dt>Artifacts</dt>
              <dd>{health.artifacts.root}</dd>
            </div>
          </dl>
          <p>{health.artifacts.policy}</p>
          {health.backups.latest ? (
            <div className="storage-mirror-status">
              <strong>最近备份</strong>
              <span>{health.backups.latest.name}</span>
              <span>{formatBytes(health.backups.latest.bytes)}</span>
              <span>{formatDate(health.backups.latest.updatedAt)}</span>
            </div>
          ) : null}
          <ul>
            {health.runtime.nextActions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      {notice ? <p className="storage-status-note">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
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
              {activeTab === 'debug' ? <StorageHealthPanel /> : null}
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
