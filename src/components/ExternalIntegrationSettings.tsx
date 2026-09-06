'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cable,
  CircleCheck,
  Database,
  FolderOpen,
  Globe2,
  Loader2,
  PencilLine,
  Plus,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { AppInput } from '@/components/ui/app-input';
import { AppModal } from '@/components/ui/app-modal';
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal';
import { CustomSelect } from '@/components/CustomSelect';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type IntegrationCategory = 'connector' | 'communication' | 'data' | 'research';

type IntegrationFieldDescriptor = {
  key: string;
  label: string;
  description?: string;
  control: 'text' | 'password' | 'url' | 'textarea' | 'select';
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  hidden?: boolean;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
  visibleWhen?: { field: string; value: string };
  picker?: 'file';
};

type IntegrationDriverDescriptor = {
  id: string;
  category: IntegrationCategory;
  label: string;
  description: string;
  testLabel: string;
  testHint?: string;
  fields: IntegrationFieldDescriptor[];
};

type IntegrationSummary = {
  id: string;
  category: IntegrationCategory;
  driverId: string;
  name: string;
  detailPreview: string;
  configuredFields: string[];
  publicConfiguration: Record<string, string>;
  enabled: boolean;
  updatedAt: string;
};

type IntegrationDraft = {
  id?: string;
  name: string;
  driverId: string;
  configuration: Record<string, string>;
  configuredFields: string[];
  clearFields: string[];
  enabled: boolean;
};

type IntegrationTestResult = {
  kind: 'operations' | 'delivered' | 'target-discovered' | 'data-source' | 'search-results';
  operationCount?: number;
  operations?: string[];
  deliveryCount?: number;
  target?: { kind: 'user' | 'group'; id: string };
  targetBinding?: string;
  tableCount?: number;
  tables?: string[];
  resultCount?: number;
  results?: string[];
};

type IntegrationTestStreamEvent =
  | { type: 'progress'; progress: { stage: 'connecting' | 'connected' | 'authenticated' | 'verifying' } }
  | { type: 'result'; result: IntegrationTestResult }
  | { type: 'error'; message: string };

const panelDefinitions: Record<IntegrationCategory, {
  addLabel: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  namePlaceholder: string;
  typeLabel: string;
  editLabel: string;
  deleteTitle: string;
}> = {
  connector: {
    addLabel: '添加连接器',
    description: '连接业务系统后，Agent 才能发现和调用这些系统提供的操作。',
    emptyTitle: '尚未连接外部系统',
    emptyDescription: '选择一种连接驱动，填写必要信息后测试连接。',
    namePlaceholder: '例如：企业业务系统',
    typeLabel: '连接类型',
    editLabel: '编辑连接器',
    deleteTitle: '删除连接器',
  },
  communication: {
    addLabel: '添加发送渠道',
    description: '每种渠道由独立驱动负责协议、认证、消息转换和结果校验。',
    emptyTitle: '尚未配置发送渠道',
    emptyDescription: '添加企业微信智能机器人或标准消息 Webhook。',
    namePlaceholder: '例如：企业微信通知',
    typeLabel: '渠道类型',
    editLabel: '编辑发送渠道',
    deleteTitle: '删除发送渠道',
  },
  data: {
    addLabel: '添加数据源',
    description: '添加 SQLite 或 PostgreSQL 数据库，填写连接信息后即可测试表结构。',
    emptyTitle: '尚未添加数据源',
    emptyDescription: '选择数据库类型并填写常规连接信息，无需编写 JSON 或连接脚本。',
    namePlaceholder: '例如：业务分析库',
    typeLabel: '数据库类型',
    editLabel: '编辑数据源',
    deleteTitle: '删除数据源',
  },
  research: {
    addLabel: '添加搜索服务',
    description: '配置 Agent 在研究任务中使用的搜索 API；公开网页抓取无需额外配置。',
    emptyTitle: '尚未配置搜索服务',
    emptyDescription: '添加符合标准请求与响应格式的 JSON 搜索 API，并先执行一次测试搜索。',
    namePlaceholder: '例如：公司搜索服务',
    typeLabel: '服务类型',
    editLabel: '编辑搜索服务',
    deleteTitle: '删除搜索服务',
  },
};

function integrationIcon(category: IntegrationCategory, size: number) {
  if (category === 'connector') return <Cable size={size} />;
  if (category === 'communication') return <Send size={size} />;
  if (category === 'data') return <Database size={size} />;
  return <Globe2 size={size} />;
}

function defaultConfiguration(driver: IntegrationDriverDescriptor | undefined) {
  return Object.fromEntries((driver?.fields || [])
    .filter((field) => field.defaultValue !== undefined)
    .map((field) => [field.key, field.defaultValue!]));
}

function visibleField(field: IntegrationFieldDescriptor, configuration: Record<string, string>) {
  return !field.hidden && (!field.visibleWhen || configuration[field.visibleWhen.field] === field.visibleWhen.value);
}

async function readIntegrationTestResult(
  response: Response,
  fallback: string,
  onProgress: (stage: 'connecting' | 'connected' | 'authenticated' | 'verifying') => void,
) {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await readApiJson<{ result?: IntegrationTestResult }>(response, fallback);
    if (!data.result) throw new Error(fallback);
    return data.result;
  }
  if (!response.ok || !response.body) throw new Error(fallback);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: IntegrationTestResult | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as IntegrationTestStreamEvent;
    if (event.type === 'progress') onProgress(event.progress.stage);
    if (event.type === 'result') result = event.result;
    if (event.type === 'error') throw new Error(event.message || fallback);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!result) throw new Error(fallback);
  return result;
}

export function ExternalIntegrationSettings({
  accessToken = '',
  category,
  permission,
}: {
  accessToken?: string;
  category: IntegrationCategory;
  permission?: {
    enabled: boolean;
    label: string;
    description: string;
    onChange: (enabled: boolean) => void;
  };
}) {
  const { t } = useI18n();
  const definition = panelDefinitions[category];
  const [items, setItems] = useState<IntegrationSummary[]>([]);
  const [drivers, setDrivers] = useState<IntegrationDriverDescriptor[]>([]);
  const [editor, setEditor] = useState<IntegrationDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IntegrationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStage, setTestStage] = useState<'connecting' | 'connected' | 'authenticated' | 'verifying' | ''>('');
  const [deleting, setDeleting] = useState(false);
  const [updatingId, setUpdatingId] = useState('');
  const [error, setError] = useState('');
  const [editorError, setEditorError] = useState('');
  const [testResult, setTestResult] = useState<{ message: string; operations?: string[] } | null>(null);
  const testAbortRef = useRef<AbortController | null>(null);
  const [hasFilePicker, setHasFilePicker] = useState(false);
  const headers = useMemo<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    if (accessToken) result.Authorization = `Bearer ${accessToken}`;
    return result;
  }, [accessToken]);
  const activeDriver = editor ? drivers.find((driver) => driver.id === editor.driverId) : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(withWebPilotBasePath(`/api/settings/integrations?category=${category}`), {
        cache: 'no-store',
        headers,
      });
      const data = await readApiJson<{ items?: IntegrationSummary[]; drivers?: IntegrationDriverDescriptor[] }>(response, t('读取外部集成失败'));
      setItems(data.items || []);
      setDrivers(data.drivers || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('读取外部集成失败'));
    } finally {
      setLoading(false);
    }
  }, [category, headers, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setHasFilePicker(Boolean(window.webPilotSystem?.selectFile));
  }, []);

  useEffect(() => () => testAbortRef.current?.abort(), []);

  function stopTest() {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTesting(false);
    setTestStage('');
  }

  function closeEditor() {
    stopTest();
    setEditor(null);
  }

  function openEditor(item?: IntegrationSummary) {
    const driver = item
      ? drivers.find((candidate) => candidate.id === item.driverId)
      : drivers[0];
    if (!driver) {
      setError(t('当前没有可用的外部集成驱动。'));
      return;
    }
    setEditor({
      id: item?.id,
      name: item?.name || '',
      driverId: driver.id,
      configuration: { ...defaultConfiguration(driver), ...(item?.publicConfiguration || {}) },
      configuredFields: item?.configuredFields || [],
      clearFields: [],
      enabled: item?.enabled ?? true,
    });
    setEditorError('');
    setTestResult(null);
  }

  function selectDriver(driverId: string) {
    const driver = drivers.find((candidate) => candidate.id === driverId);
    if (!driver) return;
    setEditor((current) => current ? {
      ...current,
      driverId,
      configuration: defaultConfiguration(driver),
      configuredFields: [],
      clearFields: [],
    } : current);
    setEditorError('');
    setTestResult(null);
  }

  function updateConfiguration(key: string, value: string) {
    setEditor((current) => {
      if (!current) return current;
      const field = drivers.find((driver) => driver.id === current.driverId)?.fields.find((candidate) => candidate.key === key);
      const shouldClear = !value.trim() && field?.secret !== true && current.configuredFields.includes(key);
      return {
        ...current,
        configuration: { ...current.configuration, [key]: value },
        clearFields: shouldClear
          ? [...new Set([...current.clearFields, key])]
          : current.clearFields.filter((configuredKey) => configuredKey !== key),
      };
    });
    setEditorError('');
    setTestResult(null);
  }

  function clearConfiguration(key: string) {
    setEditor((current) => current ? {
      ...current,
      configuration: { ...current.configuration, [key]: '' },
      configuredFields: current.configuredFields.filter((field) => field !== key),
      clearFields: [...new Set([...current.clearFields, key])],
    } : current);
    setEditorError('');
    setTestResult(null);
  }

  async function chooseFile(key: string) {
    const bridge = window.webPilotSystem;
    if (!bridge?.selectFile || !editor) return;
    const result = await bridge.selectFile({ defaultPath: editor.configuration[key] || undefined });
    if (result.ok && result.path) updateConfiguration(key, result.path);
    else if (!result.canceled && result.error) setEditorError(result.error);
  }

  function validateDraft(draft: IntegrationDraft) {
    if (!draft.name.trim()) return t('请输入名称。');
    const driver = drivers.find((candidate) => candidate.id === draft.driverId);
    if (!driver) return t('请选择连接类型。');
    for (const field of driver.fields) {
      if (!field.required || !visibleField(field, draft.configuration)) continue;
      const hasCurrentValue = Boolean(draft.configuration[field.key]?.trim());
      const hasStoredValue = draft.configuredFields.includes(field.key) && !draft.clearFields.includes(field.key);
      if (!hasCurrentValue && !hasStoredValue) return t('请填写{name}。', { name: t(field.label) });
    }
    return '';
  }

  function requestBody(draft: IntegrationDraft) {
    return {
      id: draft.id,
      category,
      driverId: draft.driverId,
      name: draft.name.trim(),
      configuration: Object.fromEntries(Object.entries(draft.configuration).filter(([, value]) => value.trim())),
      clearFields: draft.clearFields,
      enabled: draft.enabled,
    };
  }

  async function save() {
    if (!editor || saving) return;
    stopTest();
    const validationError = validateDraft(editor);
    if (validationError) {
      setEditorError(validationError);
      return;
    }
    setSaving(true);
    setEditorError('');
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/integrations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(requestBody(editor)),
      });
      await readApiJson(response, t('保存外部集成失败'));
      setEditor(null);
      await load();
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : t('保存外部集成失败'));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!editor) return;
    if (testing) {
      stopTest();
      return;
    }
    const validationError = validateDraft(editor);
    if (validationError) {
      setEditorError(validationError);
      return;
    }
    setTesting(true);
    setTestStage('connecting');
    setEditorError('');
    setTestResult(null);
    const testController = new AbortController();
    testAbortRef.current = testController;
    try {
      const requested = requestBody(editor);
      const response = await fetch(withWebPilotBasePath('/api/settings/integrations/test?stream=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        signal: testController.signal,
        body: JSON.stringify({
          id: requested.id,
          category: requested.category,
          driverId: requested.driverId,
          name: requested.name,
          configuration: requested.configuration,
          clearFields: requested.clearFields,
        }),
      });
      const result = await readIntegrationTestResult(response, t('测试外部集成失败'), setTestStage);
      if (result?.kind === 'target-discovered' && result.target) {
        setEditor((current) => current ? {
          ...current,
          configuration: {
            ...current.configuration,
            defaultTargetKind: result.target!.kind,
            defaultTarget: result.target!.id,
            defaultTargetBinding: result.targetBinding || '',
          },
          clearFields: current.clearFields.filter((key) => (
            key !== 'defaultTargetKind' && key !== 'defaultTarget' && key !== 'defaultTargetBinding'
          )),
        } : current);
      }
      setTestResult({
        message: result?.kind === 'operations'
          ? t('连接成功，发现 {count} 个可用操作。', { count: result.operationCount || 0 })
          : result?.kind === 'target-discovered'
            ? t('已识别并验证{type}会话；测试消息已由企业微信接受，点击保存后即可发送。', { type: t(result.target?.kind === 'group' ? '群聊' : '单聊') })
            : result?.kind === 'data-source'
              ? t('连接成功，读取到 {count} 张数据表。', { count: result.tableCount || 0 })
              : result?.kind === 'search-results'
                ? t('搜索服务可用，测试返回 {count} 条结果。', { count: result.resultCount || 0 })
                : t('测试消息已被渠道接受。'),
        operations: result?.operations || result?.tables || result?.results,
      });
    } catch (testError) {
      if (!testController.signal.aborted) {
        setEditorError(testError instanceof Error ? testError.message : t('测试外部集成失败'));
      }
    } finally {
      if (testAbortRef.current === testController) {
        testAbortRef.current = null;
        setTesting(false);
        setTestStage('');
      }
    }
  }

  async function toggle(item: IntegrationSummary) {
    if (updatingId) return;
    setUpdatingId(item.id);
    setError('');
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/integrations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          id: item.id,
          category: item.category,
          driverId: item.driverId,
          name: item.name,
          configuration: {},
          enabled: !item.enabled,
        }),
      });
      const data = await readApiJson<{ item?: IntegrationSummary }>(response, t('更新外部集成失败'));
      if (data.item) setItems((current) => current.map((entry) => entry.id === item.id ? data.item! : entry));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : t('更新外部集成失败'));
    } finally {
      setUpdatingId('');
    }
  }

  async function remove() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch(withWebPilotBasePath(`/api/settings/integrations?id=${encodeURIComponent(deleteTarget.id)}`), {
        method: 'DELETE',
        headers,
      });
      await readApiJson(response, t('删除外部集成失败'));
      setItems((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('删除外部集成失败'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="external-integration-settings">
      <div className="external-integration-toolbar">
        <p>{t(definition.description)}</p>
        <button className="ui-button ui-button--neutral" disabled={loading || !drivers.length} onClick={() => openEditor()} type="button">
          <Plus size={15} />
          {t(definition.addLabel)}
        </button>
      </div>

      {permission ? (
        <div className="external-integration-permission">
          <div>
            <strong>{t(permission.label)}</strong>
            <span>{t(permission.description)}</span>
          </div>
          <button
            aria-pressed={permission.enabled}
            className={`settings-toggle${permission.enabled ? ' on' : ''}`}
            onClick={() => permission.onChange(!permission.enabled)}
            type="button"
          >
            <span />
          </button>
        </div>
      ) : null}

      {error ? <p className="external-integration-error" role="alert">{t(error)}</p> : null}

      {loading ? (
        <div className="external-integration-loading"><Loader2 className="spin" size={16} />{t('正在读取配置')}</div>
      ) : items.length ? (
        <div className="external-integration-list">
          {items.map((item) => {
            const driver = drivers.find((candidate) => candidate.id === item.driverId);
            return (
              <div className="external-integration-row" key={item.id}>
                <span className="external-integration-icon" aria-hidden="true">
                  {integrationIcon(category, 17)}
                </span>
                <div className="external-integration-copy">
                  <div>
                    <strong>{item.name}</strong>
                    <span className={item.enabled ? 'is-enabled' : 'is-disabled'}>{t(item.enabled ? '已启用' : '已停用')}</span>
                  </div>
                  <span>{t(driver?.label || item.driverId)} · {item.detailPreview}</span>
                </div>
                <div className="external-integration-actions">
                  <button
                    aria-label={t(item.enabled ? '停用 {name}' : '启用 {name}', { name: item.name })}
                    aria-pressed={item.enabled}
                    className={`settings-toggle${item.enabled ? ' on' : ''}`}
                    disabled={Boolean(updatingId)}
                    onClick={() => void toggle(item)}
                    type="button"
                  ><span /></button>
                  <button className="ui-icon-button" aria-label={t('编辑 {name}', { name: item.name })} onClick={() => openEditor(item)} type="button"><PencilLine size={15} /></button>
                  <button className="ui-icon-button danger" aria-label={t('删除 {name}', { name: item.name })} onClick={() => setDeleteTarget(item)} type="button"><Trash2 size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="external-integration-empty">
          <span className="external-integration-icon" aria-hidden="true">
            {integrationIcon(category, 18)}
          </span>
          <div><strong>{t(definition.emptyTitle)}</strong><span>{t(definition.emptyDescription)}</span></div>
        </div>
      )}

      {editor && activeDriver ? (
        <AppModal
          ariaLabelledBy={`${category}-integration-modal-title`}
          dialogClassName="ui-modal ui-modal--form external-integration-modal"
          dismissable={!saving}
          keyboardDismissable={!saving}
          onClose={closeEditor}
          size="wide"
        >
          <header className="ui-modal-header">
            <div className="ui-modal-heading ui-modal-heading--with-icon">
              <span className="ui-modal-heading-icon external-integration-modal-icon" aria-hidden="true">
                {integrationIcon(category, 18)}
              </span>
              <div className="ui-modal-heading-copy">
                <h2 className="ui-modal-title" id={`${category}-integration-modal-title`}>{t(editor.id ? definition.editLabel : definition.addLabel)}</h2>
                <p className="ui-modal-subtitle">{t(activeDriver.description)}</p>
              </div>
            </div>
            <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" disabled={saving} onClick={closeEditor} type="button"><X size={16} /></button>
          </header>

          <div className="ui-modal-body external-integration-form">
            <label>
              <span>{t('名称')}</span>
              <AppInput disabled={saving || testing} onChange={(event) => setEditor((current) => current ? { ...current, name: event.target.value } : current)} placeholder={t(definition.namePlaceholder)} value={editor.name} />
            </label>
            <label>
              <span>{t(definition.typeLabel)}</span>
              <CustomSelect
                className="settings-control"
                disabled={Boolean(editor.id) || saving || testing}
                onChange={selectDriver}
                options={drivers.map((driver) => ({ label: t(driver.label), value: driver.id }))}
                value={editor.driverId}
              />
            </label>

            {activeDriver.fields.filter((field) => visibleField(field, editor.configuration)).map((field) => {
              const hasStoredValue = editor.configuredFields.includes(field.key) && !editor.clearFields.includes(field.key);
              const fieldClassName = field.control === 'textarea' || field.control === 'url' ? 'wide' : undefined;
              return (
                <label className={fieldClassName} key={field.key}>
                  <span>
                    {t(field.label)}
                    {hasStoredValue && field.secret ? <small>{t('已安全保存')}</small> : null}
                    {!hasStoredValue && field.secret ? <small>{t('加密保存')}</small> : null}
                    {hasStoredValue && field.secret ? (
                      <button className="external-integration-clear-field" onClick={() => clearConfiguration(field.key)} type="button">{t('清除')}</button>
                    ) : null}
                  </span>
                  {field.control === 'select' ? (
                    <CustomSelect
                      className="settings-control"
                      disabled={saving || testing}
                      onChange={(value) => updateConfiguration(field.key, value)}
                      options={(field.options || []).map((option) => ({ label: t(option.label), value: option.value }))}
                      value={editor.configuration[field.key] || field.defaultValue || ''}
                    />
                  ) : field.control === 'textarea' ? (
                    <textarea
                      className="settings-control external-integration-textarea"
                      disabled={saving || testing}
                      onChange={(event) => updateConfiguration(field.key, event.target.value)}
                      placeholder={t(hasStoredValue ? '已安全保存，留空则不修改' : field.placeholder || '')}
                      rows={3}
                      value={editor.configuration[field.key] || ''}
                    />
                  ) : field.picker === 'file' ? (
                    <div className="external-integration-path-control">
                      <AppInput
                        disabled={saving || testing}
                        onChange={(event) => updateConfiguration(field.key, event.target.value)}
                        placeholder={t(field.placeholder || '')}
                        type="text"
                        value={editor.configuration[field.key] || ''}
                      />
                      {hasFilePicker ? (
                        <button className="ui-button ui-button--neutral" disabled={saving || testing} onClick={() => void chooseFile(field.key)} type="button">
                          <FolderOpen size={15} />
                          {t('选择文件')}
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <AppInput
                      autoComplete={field.secret ? 'new-password' : undefined}
                      disabled={saving || testing}
                      onChange={(event) => updateConfiguration(field.key, event.target.value)}
                      placeholder={t(hasStoredValue ? '已安全保存，留空则不修改' : field.placeholder || '')}
                      type={field.control === 'password' ? 'password' : field.control === 'url' ? 'url' : 'text'}
                      value={editor.configuration[field.key] || ''}
                    />
                  )}
                  {field.description ? <small className="external-integration-field-description">{t(field.description)}</small> : null}
                </label>
              );
            })}

            <div className="external-integration-enabled-field wide">
              <div><strong>{t('启用')}</strong><span>{t('停用后保留配置，但 Agent 不会加载它。')}</span></div>
              <button aria-pressed={editor.enabled} className={`settings-toggle${editor.enabled ? ' on' : ''}`} disabled={saving || testing} onClick={() => setEditor((current) => current ? { ...current, enabled: !current.enabled } : current)} type="button"><span /></button>
            </div>
            {activeDriver.testHint ? (
              <div className={`external-integration-test-hint wide${testing ? ' is-waiting' : ''}`} role={testing ? 'status' : undefined}>
                <Send aria-hidden="true" size={14} />
                <div>
                  <strong>{t(testing
                    ? testStage === 'verifying'
                      ? '已识别会话，正在回发测试消息'
                      : testStage === 'authenticated'
                      ? '连接已就绪，请现在发送消息'
                      : testStage === 'connected'
                        ? '网络已连接，正在认证机器人'
                        : '正在连接企业微信机器人'
                    : '自动识别接收会话')}</strong>
                  <span>{t(testing
                    ? testStage === 'verifying'
                      ? '正在通过企业微信消息 MCP 校验该会话是否可以接收消息。'
                      : testStage === 'authenticated'
                      ? '请现在到企业微信给机器人发送一条消息；群聊中需要 @机器人。'
                      : testStage === 'connected'
                        ? '已连接企业微信，正在校验 Bot ID 和 Secret。'
                        : activeDriver.testHint
                    : activeDriver.testHint)}</span>
                </div>
              </div>
            ) : null}
            {testResult ? (
              <div className="external-integration-test-result wide" role="status">
                <CircleCheck aria-hidden="true" size={15} />
                <div>
                  <strong>{testResult.message}</strong>
                  {testResult.operations?.length ? <span>{testResult.operations.join('、')}</span> : null}
                </div>
              </div>
            ) : null}
            {editorError ? <p className="external-integration-modal-error wide" role="alert">{t(editorError)}</p> : null}
          </div>

          <footer className="ui-modal-footer">
            <button className="ui-button ui-button--neutral" disabled={saving} onClick={closeEditor} type="button">{t('取消')}</button>
            <button className="ui-button ui-button--neutral" disabled={saving} onClick={() => void test()} type="button">
              {testing ? <X size={15} /> : integrationIcon(category, 15)}
              {t(testing ? '停止测试' : activeDriver.testLabel)}
            </button>
            <button className="ui-button ui-button--primary" disabled={saving} onClick={() => void save()} type="button">
              {saving ? <Loader2 className="spin" size={15} /> : null}
              {t(saving ? '正在保存' : '保存')}
            </button>
          </footer>
        </AppModal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDeleteModal
          deleting={deleting}
          description={t('删除后，Agent 将无法再使用这个外部集成。')}
          error={error}
          id={`${category}-integration-delete-title`}
          itemTitle={deleteTarget.name}
          onClose={() => setDeleteTarget(null)}
          onConfirm={remove}
          title={t(definition.deleteTitle)}
        />
      ) : null}
    </div>
  );
}
