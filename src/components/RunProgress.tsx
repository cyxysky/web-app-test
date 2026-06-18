'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Bug, CheckCircle2, ChevronRight, Eye, Loader2, Maximize2, Minus, PauseCircle, PlayCircle, Plus, Radar, RotateCcw, Save, SkipForward, Trash2, Wrench, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CustomSelect } from '@/components/CustomSelect';
import { MarkdownReport } from '@/components/MarkdownReport';
import { RunMetaDrawer } from '@/components/RunMetaDrawer';
import { RunScreenshotChainButton } from '@/components/RunScreenshotChain';
import { useI18n } from '@/i18n/I18nProvider';
import { domTreeFromToolCall } from '@/lib/ai-request-inspection';
import { artifactApiUrl as artifactUrl } from '@/lib/artifacts';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { subscribeRealtimeRefresh } from '@/lib/realtime-refresh';
import type { RunDebugEvent, StepExecutionResult, TaskFrame, TaskLedgerItem, TestCaseContent, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

type ImageItem = { title: string; url: string };
type StepToolCallItem = NonNullable<StepExecutionResult['tools']>[number];
type ToolDraftStatus = 'success' | 'failed' | 'pending';
type ToolDraft = StepToolCallItem & {
  draftId: string;
  inputText: string;
  okState: ToolDraftStatus;
  sourceToolIndex?: number;
};

type ToolRecordSavePayload = StepToolCallItem & {
  sourceToolIndex?: number;
};
type TranslateFn = (value: string, params?: Record<string, string | number>) => string;
type ToolEditorMode = 'dom' | 'visual-markers';
type ToolParamField = {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'stringList' | 'fieldList';
  helper?: string;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
};
type ToolDefinition = {
  name: string;
  label: string;
  mode: 'shared' | 'dom' | 'visual' | 'editor';
  fields: ToolParamField[];
  template: Record<string, unknown>;
};

function normalizeEvidenceMarkdownSegment(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\s+\*\s+(?=\*\*[^*\n]{1,80}\*\*\s*[:：])/g, '\n- ')
    .replace(/^\*\s+(?=\*\*[^*\n]{1,80}\*\*\s*[:：])/gm, '- ')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeEvidenceMarkdown(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith('```') ? part : normalizeEvidenceMarkdownSegment(part)))
    .join('')
    .trim();
}

function EvidenceMarkdown({ markdown }: { markdown: string }) {
  const normalizedMarkdown = useMemo(() => normalizeEvidenceMarkdown(markdown), [markdown]);
  return (
    <div className="evidence-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

const statusFieldOptions = [
  { label: '通过', value: 'passed' },
  { label: '失败', value: 'failed' },
  { label: '阻塞', value: 'blocked' },
];

const keyFieldOptions = [
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
].map((value) => ({ label: value, value }));

const outputFormatOptions = [
  { label: 'Markdown', value: 'markdown' },
  { label: '纯文本', value: 'plainText' },
  { label: 'JSON', value: 'json' },
];

const toolDefinitions: ToolDefinition[] = [
  {
    name: 'openPage',
    label: '打开页面',
    mode: 'shared',
    template: { url: '' },
    fields: [{ key: 'url', label: '目标地址', kind: 'text', placeholder: 'https://example.com' }],
  },
  {
    name: 'openUrl',
    label: '打开地址',
    mode: 'shared',
    template: { url: '' },
    fields: [{ key: 'url', label: '目标地址', kind: 'text', placeholder: 'https://example.com' }],
  },
  {
    name: 'scrollArea',
    label: '滚动区域',
    mode: 'shared',
    template: { areaId: 'S1', deltaY: 700, deltaX: 0 },
    fields: [
      { key: 'areaId', label: '滚动区域 ID', kind: 'text', placeholder: 'S1' },
      { key: 'deltaY', label: '纵向滚动量', kind: 'number' },
      { key: 'deltaX', label: '横向滚动量', kind: 'number' },
    ],
  },
  {
    name: 'waitForPage',
    label: '等待页面',
    mode: 'shared',
    template: { ms: 1000 },
    fields: [{ key: 'ms', label: '等待毫秒', kind: 'number' }],
  },
  {
    name: 'waitForHumanVerification',
    label: '等待人工验证',
    mode: 'shared',
    template: { maxMs: 180000 },
    fields: [{ key: 'maxMs', label: '最长等待毫秒', kind: 'number' }],
  },
  {
    name: 'listTabs',
    label: '列出标签页',
    mode: 'shared',
    template: {},
    fields: [],
  },
  {
    name: 'switchTab',
    label: '切换标签页',
    mode: 'shared',
    template: { index: 0 },
    fields: [{ key: 'index', label: '标签页序号', kind: 'number' }],
  },
  {
    name: 'getHttpRequests',
    label: '获取 HTTP 请求',
    mode: 'shared',
    template: {},
    fields: [],
  },
  {
    name: 'typeText',
    label: '输入文本',
    mode: 'shared',
    template: { text: '' },
    fields: [{ key: 'text', label: '输入内容', kind: 'textarea' }],
  },
  {
    name: 'pressKey',
    label: '按键',
    mode: 'shared',
    template: { key: 'Enter' },
    fields: [{ key: 'key', label: '按键', kind: 'select', options: keyFieldOptions }],
  },
  {
    name: 'downloadFile',
    label: '下载文件',
    mode: 'shared',
    template: { url: '', fileName: '' },
    fields: [
      { key: 'url', label: '文件地址', kind: 'text' },
      { key: 'path', label: '相对路径', kind: 'text' },
      { key: 'urlOrPath', label: '地址或路径', kind: 'text' },
      { key: 'fileName', label: '文件名', kind: 'text' },
    ],
  },
  {
    name: 'generateMarkdownFile',
    label: '生成 Markdown 文件',
    mode: 'shared',
    template: { fileName: '', title: '', content: '' },
    fields: [
      { key: 'fileName', label: '文件名', kind: 'text' },
      { key: 'title', label: '标题', kind: 'text' },
      { key: 'content', label: 'Markdown 内容', kind: 'textarea' },
    ],
  },
  {
    name: 'reportState',
    label: '报告状态',
    mode: 'shared',
    template: { status: 'passed', done: false, action: '', expected: '', actual: '' },
    fields: [
      { key: 'status', label: '结论状态', kind: 'select', options: statusFieldOptions },
      { key: 'done', label: '是否结束用例', kind: 'boolean' },
      { key: 'action', label: '状态摘要', kind: 'textarea' },
      { key: 'expected', label: '预期', kind: 'textarea' },
      { key: 'actual', label: '实际证据', kind: 'textarea' },
    ],
  },
  {
    name: 'selectReferenceScreenshots',
    label: '选择参考截图',
    mode: 'shared',
    template: { ids: [], selectionReason: '' },
    fields: [
      { key: 'ids', label: '截图 ID', kind: 'stringList', helper: '每行一个截图 ID。' },
      { key: 'selectionReason', label: '选择原因', kind: 'textarea' },
      { key: 'sameInterfaceGroup', label: '同界面分组', kind: 'text' },
    ],
  },
  {
    name: 'generateText',
    label: 'AI 文本生成',
    mode: 'editor',
    template: { prompt: '', outputFormat: 'markdown', includeDomTree: true, includePageText: true, includeScreenshot: true, maxCharacters: 1200 },
    fields: [
      { key: 'prompt', label: '生成提示词', kind: 'textarea', helper: '写清楚需要 AI 基于当前界面分析、总结或提取什么。' },
      { key: 'outputFormat', label: '输出格式', kind: 'select', options: outputFormatOptions },
      { key: 'includeDomTree', label: '包含 DOM 树', kind: 'boolean' },
      { key: 'includePageText', label: '包含页面文本', kind: 'boolean' },
      { key: 'includeScreenshot', label: '包含当前截图', kind: 'boolean' },
      { key: 'maxCharacters', label: '最长输出字符', kind: 'number' },
    ],
  },
  {
    name: 'clickCandidate',
    label: '点击候选元素',
    mode: 'visual',
    template: { id: '', targetVisual: '', text: '' },
    fields: [
      { key: 'id', label: '候选 ID', kind: 'text' },
      { key: 'targetVisual', label: '可见目标描述', kind: 'textarea' },
      { key: 'text', label: '点击后输入内容', kind: 'textarea' },
    ],
  },
  {
    name: 'fillCandidates',
    label: '填写候选元素',
    mode: 'visual',
    template: { fields: [{ id: '', text: '', clear: true }] },
    fields: [{ key: 'fields', label: '填写字段', kind: 'fieldList', helper: '每行一个字段，格式：候选ID=文本。' }],
  },
  {
    name: 'focusCandidate',
    label: '聚焦候选元素',
    mode: 'visual',
    template: { id: '' },
    fields: [{ key: 'id', label: '候选 ID', kind: 'text' }],
  },
  {
    name: 'hoverCandidate',
    label: '悬停候选元素',
    mode: 'visual',
    template: { id: '', targetVisual: '' },
    fields: [
      { key: 'id', label: '候选 ID', kind: 'text' },
      { key: 'targetVisual', label: '可见目标描述', kind: 'textarea' },
    ],
  },
  {
    name: 'doubleClickCandidate',
    label: '双击候选元素',
    mode: 'visual',
    template: { id: '', targetVisual: '' },
    fields: [
      { key: 'id', label: '候选 ID', kind: 'text' },
      { key: 'targetVisual', label: '可见目标描述', kind: 'textarea' },
    ],
  },
  {
    name: 'rightClickCandidate',
    label: '右击候选元素',
    mode: 'visual',
    template: { id: '', targetVisual: '' },
    fields: [
      { key: 'id', label: '候选 ID', kind: 'text' },
      { key: 'targetVisual', label: '可见目标描述', kind: 'textarea' },
    ],
  },
  {
    name: 'dragCandidate',
    label: '拖拽候选元素',
    mode: 'visual',
    template: { fromId: '', toId: '', targetVisual: '' },
    fields: [
      { key: 'fromId', label: '起点候选 ID', kind: 'text' },
      { key: 'toId', label: '终点候选 ID', kind: 'text' },
      { key: 'targetVisual', label: '可见目标描述', kind: 'textarea' },
    ],
  },
  {
    name: 'getInteractiveCandidates',
    label: '获取交互候选',
    mode: 'visual',
    template: {},
    fields: [],
  },
  {
    name: 'clickDomNode',
    label: '点击 DOM 节点',
    mode: 'dom',
    template: { id: '', text: '' },
    fields: [
      { key: 'id', label: 'DOM 节点 ID', kind: 'text' },
      { key: 'text', label: '点击后输入内容', kind: 'textarea' },
    ],
  },
  {
    name: 'fillDomNodes',
    label: '填写 DOM 节点',
    mode: 'dom',
    template: { fields: [{ id: '', text: '', clear: true }] },
    fields: [{ key: 'fields', label: '填写字段', kind: 'fieldList', helper: '每行一个字段，格式：DOM节点ID=文本。' }],
  },
  {
    name: 'focusDomNode',
    label: '聚焦 DOM 节点',
    mode: 'dom',
    template: { id: '' },
    fields: [{ key: 'id', label: 'DOM 节点 ID', kind: 'text' }],
  },
  {
    name: 'findByText',
    label: '查找文本',
    mode: 'dom',
    template: { targetText: '', scopeId: '' },
    fields: [
      { key: 'targetText', label: '目标文本', kind: 'textarea' },
      { key: 'scopeId', label: '范围 DOM ID', kind: 'text' },
    ],
  },
  {
    name: 'clickLocator',
    label: '点击定位器',
    mode: 'dom',
    template: { locatorId: '', text: '' },
    fields: [
      { key: 'locatorId', label: '定位器 ID', kind: 'text' },
      { key: 'text', label: '点击后输入内容', kind: 'textarea' },
    ],
  },
  {
    name: 'getDomNodeText',
    label: '读取 DOM 节点文本',
    mode: 'dom',
    template: { id: '' },
    fields: [{ key: 'id', label: 'DOM 节点 ID', kind: 'text' }],
  },
];

const toolDefinitionsByName = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition])) as Record<string, ToolDefinition>;
const toolDisplayLabels: Record<string, string> = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition.label]));

function toolDisplayName(name: string, t: TranslateFn) {
  return t(toolDisplayLabels[name] || name);
}

function toolOptionLabel(name: string, t: TranslateFn) {
  const label = toolDisplayName(name, t);
  return label === name ? name : `${label} (${name})`;
}

const toolStatusOptions = [
  { label: '成功 / 参与重放', value: 'success' },
  { label: '失败 / 不参与重放', value: 'failed' },
  { label: '未定 / 参与重放', value: 'pending' },
];

function traceUrl(run: TestRunRecord) {
  return artifactUrl(run.result?.tracePath);
}

function isFinished(status: TestRunRecord['status']) {
  return status === 'passed' || status === 'failed' || status === 'blocked';
}

function statusLabel(status: string) {
  return ({ queued: '排队中', running: '运行中', paused: '已暂停', passed: '通过', failed: '失败', blocked: '阻塞' } as Record<string, string>)[status] || status;
}

function StepIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 className="spin" size={16} />;
  return <Wrench size={16} />;
}

function selectedOrLatest(steps: StepExecutionResult[], selectedIndex?: number) {
  if (!steps.length) return undefined;
  return steps.find((step) => step.index === selectedIndex) || steps[steps.length - 1];
}

function formatToolInput(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function stringifyToolInputForEdit(input: unknown) {
  try {
    return JSON.stringify(input ?? {}, null, 2) || '{}';
  } catch {
    return '{}';
  }
}

function toolTemplateText(name: string) {
  return stringifyToolInputForEdit(toolDefinitionsByName[name]?.template || {});
}

function parseToolInputObject(inputText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(inputText.trim() || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toolInputParseError(inputText: string) {
  try {
    const parsed = JSON.parse(inputText.trim() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '工具参数必须是 JSON 对象';
    return '';
  } catch {
    return '工具参数不是合法 JSON';
  }
}

function fieldListToText(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      const record = item as Record<string, unknown>;
      const id = String(record.id || '').trim();
      if (!id) return '';
      return `${id}=${typeof record.text === 'string' ? record.text : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

function textToFieldList(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex < 0) return { id: line, text: '', clear: true };
      return {
        id: line.slice(0, separatorIndex).trim(),
        text: line.slice(separatorIndex + 1),
        clear: true,
      };
    })
    .filter((item) => item.id);
}

function stringListToText(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value.map((item) => String(item || '').trim()).filter(Boolean).join('\n');
}

function textToStringList(value: string) {
  return value
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toolNamesForMode(mode: ToolEditorMode) {
  return toolDefinitions
    .filter((definition) => (
      definition.mode === 'shared'
      || definition.mode === 'editor'
      || (mode === 'dom' ? definition.mode === 'dom' : definition.mode === 'visual')
    ))
    .map((definition) => definition.name);
}

function normalizeEditorMode(value: unknown): ToolEditorMode | undefined {
  return value === 'visual-markers' ? 'visual-markers' : value === 'dom' ? 'dom' : undefined;
}

function inferModeFromStep(step?: StepExecutionResult): ToolEditorMode | undefined {
  const requestMode = normalizeEditorMode(step?.aiRequest?.options?.browserMode);
  if (requestMode) return requestMode;
  const names = new Set((step?.tools || []).map((tool) => tool.name));
  if ([...names].some((name) => toolDefinitionsByName[name]?.mode === 'visual')) return 'visual-markers';
  if ([...names].some((name) => toolDefinitionsByName[name]?.mode === 'dom')) return 'dom';
  return undefined;
}

function toolModeLabel(mode: ToolEditorMode, t: TranslateFn) {
  return mode === 'visual-markers' ? t('视觉模式工具') : t('DOM 模式工具');
}

function toolModeTag(definition: ToolDefinition | undefined, t: TranslateFn) {
  if (!definition) return t('未知工具');
  if (definition.mode === 'dom') return t('DOM');
  if (definition.mode === 'visual') return t('视觉');
  if (definition.mode === 'editor') return t('编辑专用');
  return t('通用');
}

function ToolParameterEditor({
  disabled,
  onChange,
  tool,
}: {
  disabled: boolean;
  onChange: (inputText: string) => void;
  tool: ToolDraft;
}) {
  const { t } = useI18n();
  const definition = toolDefinitionsByName[tool.name];
  const parseError = toolInputParseError(tool.inputText);
  const input = parseToolInputObject(tool.inputText);

  function updateValue(key: string, value: unknown) {
    const next = { ...parseToolInputObject(tool.inputText) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(stringifyToolInputForEdit(next));
  }

  function renderField(field: ToolParamField) {
    const rawValue = input[field.key];
    const label = t(field.label);
    const helper = field.helper ? <span className="run-tool-field-helper">{t(field.helper)}</span> : null;

    if (field.kind === 'boolean') {
      return (
        <label className="run-tool-field boolean" key={field.key}>
          <input
            checked={rawValue !== false}
            disabled={disabled}
            onChange={(event) => updateValue(field.key, event.target.checked)}
            type="checkbox"
          />
          <span>{label}</span>
          {helper}
        </label>
      );
    }

    if (field.kind === 'select') {
      const value = typeof rawValue === 'string' ? rawValue : field.options?.[0]?.value || '';
      const options = field.options?.map((option) => ({ ...option, label: t(option.label) })) || [];
      return (
        <label className="run-tool-field" key={field.key}>
          <span>{label}</span>
          <CustomSelect
            disabled={disabled}
            options={options}
            value={value}
            onChange={(nextValue) => updateValue(field.key, nextValue)}
          />
          {helper}
        </label>
      );
    }

    if (field.kind === 'number') {
      const value = typeof rawValue === 'number' || typeof rawValue === 'string' ? String(rawValue) : '';
      return (
        <label className="run-tool-field" key={field.key}>
          <span>{label}</span>
          <input
            className="input compact"
            disabled={disabled}
            onChange={(event) => {
              const nextValue = event.target.value.trim();
              updateValue(field.key, nextValue ? Number(nextValue) : undefined);
            }}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            type="number"
            value={value}
          />
          {helper}
        </label>
      );
    }

    if (field.kind === 'fieldList') {
      return (
        <label className="run-tool-field wide" key={field.key}>
          <span>{label}</span>
          <textarea
            className="textarea compact run-tool-field-textarea"
            disabled={disabled}
            onChange={(event) => updateValue(field.key, textToFieldList(event.target.value))}
            placeholder={field.placeholder ? t(field.placeholder) : '1=示例文本'}
            value={fieldListToText(rawValue)}
          />
          {helper}
        </label>
      );
    }

    if (field.kind === 'stringList') {
      return (
        <label className="run-tool-field wide" key={field.key}>
          <span>{label}</span>
          <textarea
            className="textarea compact run-tool-field-textarea"
            disabled={disabled}
            onChange={(event) => updateValue(field.key, textToStringList(event.target.value))}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            value={stringListToText(rawValue)}
          />
          {helper}
        </label>
      );
    }

    if (field.kind === 'textarea') {
      return (
        <label className="run-tool-field wide" key={field.key}>
          <span>{label}</span>
          <textarea
            className="textarea compact run-tool-field-textarea"
            disabled={disabled}
            onChange={(event) => updateValue(field.key, event.target.value)}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            value={typeof rawValue === 'string' ? rawValue : ''}
          />
          {helper}
        </label>
      );
    }

    return (
      <label className="run-tool-field" key={field.key}>
        <span>{label}</span>
        <input
          className="input compact"
          disabled={disabled}
          onChange={(event) => updateValue(field.key, event.target.value)}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          value={typeof rawValue === 'string' || typeof rawValue === 'number' ? String(rawValue) : ''}
        />
        {helper}
      </label>
    );
  }

  if (!definition) {
    return (
      <label className="run-tool-editor-param">
        {t('参数 JSON')}
        <textarea
          className="textarea compact run-tool-param-textarea"
          disabled={disabled}
          value={tool.inputText}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
      </label>
    );
  }

  return (
    <div className="run-tool-fields">
      <div className="run-tool-fields-head">
        <span>{t('输入参数')}</span>
        <span className="run-tool-mode-pill">{toolModeTag(definition, t)}</span>
      </div>
      {parseError ? <div className="error compact-error">{t(parseError)}</div> : null}
      {definition.fields.length ? (
        <div className="run-tool-field-grid">
          {definition.fields.map(renderField)}
        </div>
      ) : (
        <p className="run-tool-empty-fields">{t('此工具没有输入参数')}</p>
      )}
    </div>
  );
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function normalizedToolInput(input: unknown) {
  return input === undefined ? {} : input;
}

function sameToolSignature(name: string, input: unknown, sourceTool?: StepToolCallItem) {
  return Boolean(sourceTool)
    && name === sourceTool?.name
    && stableStringify(normalizedToolInput(input)) === stableStringify(normalizedToolInput(sourceTool?.input));
}

function parsedToolDraftInput(tool: ToolDraft) {
  const rawInput = tool.inputText.trim();
  if (!rawInput) return { ok: true as const, input: undefined };
  try {
    return { ok: true as const, input: JSON.parse(rawInput) as unknown };
  } catch {
    return { ok: false as const, input: undefined };
  }
}

function evidenceSourceForDraft(tool: ToolDraft, step: StepExecutionResult) {
  if (tool.sourceToolIndex === undefined) return undefined;
  const sourceTool = step.tools?.[tool.sourceToolIndex];
  const parsed = parsedToolDraftInput(tool);
  if (!parsed.ok || !sameToolSignature(tool.name, parsed.input, sourceTool)) return undefined;
  return sourceTool;
}

function toolDraftStatus(tool: StepToolCallItem): ToolDraftStatus {
  if (tool.ok === true) return 'success';
  if (tool.ok === false) return 'failed';
  return 'pending';
}

function toolDraftFromCall(tool: StepToolCallItem, index: number): ToolDraft {
  return {
    ...tool,
    draftId: `tool-${index}-${tool.name}-${Math.random().toString(36).slice(2, 8)}`,
    inputText: stringifyToolInputForEdit(tool.input),
    okState: toolDraftStatus(tool),
    sourceToolIndex: index,
  };
}

function newToolDraft(name = 'waitForPage'): ToolDraft {
  return {
    draftId: `tool-manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    inputText: toolTemplateText(name),
    okState: 'success',
    reason: '',
  };
}

function toolOkFromDraft(status: ToolDraftStatus) {
  if (status === 'success') return true;
  if (status === 'failed') return false;
  return undefined;
}

function toolStatusLabel(ok?: boolean) {
  if (ok === true) return '成功';
  if (ok === false) return '失败';
  return '执行中';
}

function toolStatusClass(ok?: boolean) {
  if (ok === false) return 'tool-status failed';
  if (ok === undefined) return 'tool-status pending';
  return 'tool-status';
}

function sameDisplayText(a?: string, b?: string) {
  const left = (a || '').replace(/\s+/g, ' ').trim();
  const right = (b || '').replace(/\s+/g, ' ').trim();
  return Boolean(left && right && left === right);
}

function visibleStepObservation(step: StepExecutionResult) {
  const observation = step.observation || step.note || '';
  return sameDisplayText(observation, step.action) ? '' : observation;
}

function compactText(value?: string, max = 120) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function stepToolBadges(step: StepExecutionResult) {
  const badges: Array<{ name: string; count: number; ok?: boolean }> = [];
  for (const tool of step.tools || []) {
    const current = badges.find((badge) => badge.name === tool.name);
    if (current) {
      current.count += 1;
      if (tool.ok === false) current.ok = false;
      else if (current.ok !== false && tool.ok === undefined) current.ok = undefined;
    } else {
      badges.push({ name: tool.name, count: 1, ok: tool.ok });
    }
  }
  return badges;
}

function ledgerKey(item: TaskLedgerItem) {
  return item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
}

function collectRunTaskFrame(run: TestRunRecord) {
  return run.result?.taskFrame || run.result?.steps.map((step) => step.taskFrame || step.workingMemory?.taskFrame).filter(Boolean).at(-1);
}

function collectRunLedgerItems(run: TestRunRecord) {
  const map = new Map<string, TaskLedgerItem>();
  const items = [
    ...(run.result?.ledgerItems || []),
    ...(run.result?.steps || []).flatMap((step) => step.ledgerItems || []),
    ...(run.result?.steps || []).flatMap((step) => step.workingMemory?.ledgerItems || []),
  ];
  for (const item of items) map.set(ledgerKey(item), item);
  return [...map.values()];
}

function dimensionLabel(frame: TaskFrame | undefined, dimensionId: string) {
  return frame?.dimensions.find((dimension) => dimension.id === dimensionId)?.name || dimensionId || '未分组';
}

function ledgerStatusLabel(status?: TaskLedgerItem['status']) {
  return ({
    covered: '已覆盖',
    decision: '结论',
    evidence: '证据',
    finding: '发现',
    issue: '问题',
    question: '疑问',
    risk: '风险',
  } as Record<string, string>)[status || 'finding'] || status || '发现';
}

function ledgerSeverityLabel(severity?: TaskLedgerItem['severity']) {
  return ({
    critical: '严重',
    info: '信息',
    major: '重要',
    minor: '一般',
  } as Record<string, string>)[severity || 'info'] || severity || '信息';
}

function ledgerToneClass(item: TaskLedgerItem) {
  if (item.severity === 'critical') return 'critical';
  if (item.severity === 'major') return 'major';
  if (item.status === 'issue' || item.status === 'risk') return 'warning';
  if (item.status === 'covered') return 'covered';
  return 'neutral';
}

function ledgerCounts(items: TaskLedgerItem[]) {
  return {
    covered: items.filter((item) => item.status === 'covered').length,
    important: items.filter((item) => item.severity === 'critical' || item.severity === 'major').length,
    issue: items.filter((item) => item.status === 'issue').length,
    question: items.filter((item) => item.status === 'question').length,
    risk: items.filter((item) => item.status === 'risk').length,
  };
}

function toolBadgeLabel(badge: { name: string; count: number }, t: TranslateFn) {
  return `${toolDisplayName(badge.name, t)}${badge.count > 1 ? ` ×${badge.count}` : ''}`;
}

function toolPreviewText(tool: StepToolCallItem, input: string, screenshotCount: number) {
  const parts: string[] = [];
  if (tool.reason) parts.push(`原因：${compactText(tool.reason, 96)}`);
  else if (tool.result) parts.push(`结果：${compactText(tool.result, 96)}`);
  else if (input) parts.push(`参数：${compactText(input, 96)}`);
  if (screenshotCount) parts.push(`${screenshotCount} 张截图`);
  return parts.join(' · ');
}

function formatDetails(details: unknown) {
  if (details === undefined) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function collectStepImages(steps: StepExecutionResult[], t: TranslateFn) {
  const images: ImageItem[] = [];
  for (const step of steps) {
    const before = artifactUrl(step.beforeScreenshotPath);
    const after = artifactUrl(step.afterScreenshotPath || step.screenshotPath);
    if (before) images.push({ title: t('步骤 {index} 操作前截图', { index: step.index }), url: before });
    if (after) images.push({ title: t('步骤 {index} 操作后截图', { index: step.index }), url: after });
    for (const tool of step.tools || []) {
      for (const [shotIndex, shot] of (tool.screenshots || []).entries()) {
        const url = artifactUrl(shot.path);
        if (url) images.push({ title: `${t('步骤 {index}', { index: step.index })} · ${toolDisplayName(tool.name, t)} · ${shot.title || t('截图 {index}', { index: shotIndex + 1 })}`, url });
      }
    }
  }
  return images;
}

function toolScreenshotItems(step: StepExecutionResult, toolIndex: number, t: TranslateFn) {
  const tool = step.tools?.[toolIndex];
  return tool ? toolCallScreenshotItems(tool, t) : [];
}

function toolCallScreenshotItems(tool: StepToolCallItem, t: TranslateFn) {
  if (!tool?.screenshots?.length) return [];
  const items: ImageItem[] = [];
  for (const [shotIndex, shot] of tool.screenshots.entries()) {
    const url = artifactUrl(shot.path);
    if (url) items.push({ title: shot.title || `${toolDisplayName(tool.name, t)} · ${t('截图 {index}', { index: shotIndex + 1 })}`, url });
  }
  return items;
}

function ToolDraftEvidenceButtons({
  index,
  openDomTree,
  openScreenshots,
  step,
  tool,
}: {
  index: number;
  openDomTree: (payload: { domTree: string; stepIndex: number; toolIndex: number; toolName: string }) => void;
  openScreenshots: (images: ImageItem[]) => void;
  step: StepExecutionResult;
  tool: ToolDraft;
}) {
  const { t } = useI18n();
  const evidenceTool = evidenceSourceForDraft(tool, step);
  const screenshots = evidenceTool ? toolCallScreenshotItems(evidenceTool, t) : [];
  const domTree = evidenceTool ? domTreeFromToolCall(evidenceTool, step.aiRequest) : '';
  if (!screenshots.length && !domTree) return null;

  return (
    <div className="run-tool-editor-evidence">
      {screenshots.length ? (
        <button className="icon-text-button tool-evidence-button" onClick={() => openScreenshots(screenshots)} type="button">
          <Eye size={14} />
          {t('操作截图')}
          <span>{screenshots.length}</span>
        </button>
      ) : null}
      {domTree ? (
        <button
          className="icon-text-button tool-evidence-button"
          onClick={() => openDomTree({ domTree, stepIndex: step.index, toolIndex: index, toolName: toolDisplayName(tool.name, t) })}
          type="button"
        >
          <Bug size={14} />
          {t('DOM 树')}
        </button>
      ) : null}
    </div>
  );
}

function ToolCallCard({
  expanded,
  index,
  onToggle,
  openImage,
  step,
  tool,
}: {
  expanded: boolean;
  index: number;
  onToggle: () => void;
  openImage: (url: string) => void;
  step: StepExecutionResult;
  tool: StepToolCallItem;
}) {
  const { t } = useI18n();
  const input = formatToolInput(tool.input);
  const screenshots = toolScreenshotItems(step, index, t);
  const preview = toolPreviewText(tool, input, screenshots.length);
  const domTree = domTreeFromToolCall(tool, step.aiRequest);

  return (
    <li className={expanded ? 'expanded' : undefined}>
      <button className="tool-call-toggle" onClick={onToggle} type="button" aria-expanded={expanded}>
        <span className="tool-call-heading">
          <span className="tool-call-title">
            <strong title={tool.name}>{toolDisplayName(tool.name, t)}</strong>
          </span>
          <span className={toolStatusClass(tool.ok)}>{t(toolStatusLabel(tool.ok))}</span>
          <ChevronRight className="tool-call-chevron" size={16} />
        </span>
        {preview ? <span className="tool-call-preview">{preview}</span> : null}
      </button>
      {expanded ? (
        <div className="tool-call-details">
          {tool.reason ? (
            <p className="tool-call-reason">
              <span>调用原因</span>
              {tool.reason}
            </p>
          ) : null}
          {input ? (
            <div className="tool-call-block">
              <span>参数</span>
              <code>{input}</code>
            </div>
          ) : null}
          {tool.result ? (
            <div className="tool-call-block">
              <span>结果</span>
              <p>{tool.result}</p>
            </div>
          ) : null}
          {domTree ? (
            <details className="debug-details">
              <summary>模型看到的 DOM 树</summary>
              <pre>{domTree}</pre>
            </details>
          ) : null}
          {screenshots.length ? (
            <div className="tool-shot-grid">
              {screenshots.map((shot) => (
                <button className="tool-shot-button" key={shot.url} onClick={() => openImage(shot.url)} type="button">
                  <img alt={shot.title} src={shot.url} />
                  <span>{shot.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DebugEventRow({ event }: { event: RunDebugEvent }) {
  const details = formatDetails(event.details);

  return (
    <li>
      <div className="debug-row-main">
        <time>{new Date(event.time).toLocaleTimeString()}</time>
        <strong>{event.phase}</strong>
        <span>{event.stepIndex ? `步骤 ${event.stepIndex} · ` : ''}{event.message}</span>
      </div>
      {details ? (
        <details className="debug-details">
          <summary>查看 AI 输出 / 工具详情</summary>
          <pre>{details}</pre>
        </details>
      ) : null}
    </li>
  );
}

function ImageViewer({ images, initialIndex, onClose }: { images: ImageItem[]; initialIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const current = images[index] || images[0];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function zoom(nextScale: number) {
    setScale(Math.min(5, Math.max(0.25, nextScale)));
  }

  function show(nextIndex: number) {
    setIndex(Math.min(Math.max(nextIndex, 0), images.length - 1));
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  if (!current) return null;

  return (
    <div
      className="fullscreen-image-viewer"
      onClick={onClose}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        zoom(scale + (event.deltaY < 0 ? 0.12 : -0.12));
      }}
      role="presentation"
    >
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <strong>{current.title}</strong>
        <div>
          <button className="icon-button" disabled={index <= 0} onClick={() => show(index - 1)} type="button">上一张</button>
          <span>{index + 1}/{images.length}</span>
          <button className="icon-button" disabled={index >= images.length - 1} onClick={() => show(index + 1)} type="button">下一张</button>
          <button className="icon-button" onClick={() => zoom(scale - 0.25)} type="button" aria-label="缩小"><Minus size={18} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button className="icon-button" onClick={() => zoom(scale + 0.25)} type="button" aria-label="放大"><Plus size={18} /></button>
          <button className="icon-button" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} type="button" aria-label="重置"><Maximize2 size={18} /></button>
          <button className="icon-button" onClick={onClose} type="button" aria-label="关闭"><X size={18} /></button>
        </div>
      </div>
      <div className="image-viewer-stage">
        <img
          alt={current.title}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y });
          }}
          onPointerMove={(event) => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            setOffset({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
          }}
          onPointerUp={() => setDrag(null)}
          src={current.url}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
    </div>
  );
}

function ReportAccordion({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="report-accordion">
      <summary>
        <ChevronRight size={16} />
        <span>{title}</span>
        <b>{items.length}</b>
      </summary>
      <div>
        {items.length ? (
          <ul>
            {items.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        ) : (
          <p>暂无记录。</p>
        )}
      </div>
    </details>
  );
}

function LedgerItemCard({ frame, item, index }: { frame?: TaskFrame; item: TaskLedgerItem; index: number }) {
  const tone = ledgerToneClass(item);
  const evidence = item.evidence?.slice(0, 4) || [];
  const attributes = item.attributes?.slice(0, 6) || [];
  return (
    <li className={`ledger-item-card ${tone}`}>
      <div className="ledger-item-index">{String(index + 1).padStart(2, '0')}</div>
      <div className="ledger-item-main">
        <div className="ledger-item-title-row">
          <strong>{item.title}</strong>
          <span className={`ledger-pill ${tone}`}>{ledgerStatusLabel(item.status)}</span>
          <span className={`ledger-pill severity-${item.severity || 'info'}`}>{ledgerSeverityLabel(item.severity)}</span>
        </div>
        {item.summary ? <p className="ledger-item-summary">{item.summary}</p> : null}
        <div className="ledger-meta-row">
          <span>{dimensionLabel(frame, item.dimensionId)}</span>
          {item.sourceStep ? <span>Step {item.sourceStep}</span> : null}
          {typeof item.confidence === 'number' ? <span>置信度 {Math.round(item.confidence * 100)}%</span> : null}
        </div>
        {item.expected || item.actual ? (
          <div className="ledger-compare-grid">
            {item.expected ? (
              <div>
                <b>期望</b>
                <p>{item.expected}</p>
              </div>
            ) : null}
            {item.actual ? (
              <div>
                <b>实际</b>
                <p>{item.actual}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {attributes.length ? (
          <div className="ledger-chip-row">
            {attributes.map((pair, pairIndex) => (
              <span key={`${pair.key}-${pairIndex}`}>{pair.key}: {pair.value}</span>
            ))}
          </div>
        ) : null}
        {evidence.length ? (
          <div className="ledger-evidence-row">
            <b>证据</b>
            {evidence.map((itemEvidence, evidenceIndex) => (
              <span key={`${itemEvidence}-${evidenceIndex}`}>{itemEvidence}</span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function LedgerItemList({ frame, items, limit }: { frame?: TaskFrame; items: TaskLedgerItem[]; limit?: number }) {
  const visibleItems = typeof limit === 'number' ? items.slice(-limit) : items;
  if (!visibleItems.length) return <p className="empty-ledger">暂无结构化台账项</p>;
  return (
    <ul className="ledger-list">
      {visibleItems.map((item, index) => (
        <LedgerItemCard frame={frame} index={index} item={item} key={`${ledgerKey(item)}-${index}`} />
      ))}
    </ul>
  );
}

function LedgerSectionCard({
  defaultOpen = false,
  description,
  frame,
  items,
  limit,
  title,
}: {
  defaultOpen?: boolean;
  description?: string;
  frame?: TaskFrame;
  items: TaskLedgerItem[];
  limit?: number;
  title: string;
}) {
  const counts = ledgerCounts(items);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="ledger-section-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={16} />
        <div className="ledger-section-title">
          <strong>{title}</strong>
          {description ? <span>{description}</span> : null}
        </div>
        <div className="ledger-section-counts">
          <span>{items.length} 条</span>
          {counts.important ? <span className="major">{counts.important} 重要</span> : null}
          {counts.issue ? <span>{counts.issue} 问题</span> : null}
          {counts.risk ? <span>{counts.risk} 风险</span> : null}
          {counts.question ? <span>{counts.question} 疑问</span> : null}
        </div>
      </summary>
      <div className="ledger-section-body">
        <LedgerItemList frame={frame} items={items} limit={limit} />
      </div>
    </details>
  );
}

function LedgerPanel({ frame, items }: { frame?: TaskFrame; items: TaskLedgerItem[] }) {
  if (!items.length) return null;
  const grouped = new Map<string, TaskLedgerItem[]>();
  for (const item of items) grouped.set(item.dimensionId || 'general', [...(grouped.get(item.dimensionId || 'general') || []), item]);
  const totals = ledgerCounts(items);
  return (
    <section className="task-ledger-panel">
      <div className="section-head compact">
        <div>
          <h2>结构化台账</h2>
          <p>{items.length} 条由 AI 在执行过程中沉淀的覆盖、发现、问题与风险</p>
        </div>
      </div>
      <div className="ledger-summary-strip">
        <span>全部 {items.length}</span>
        <span>已覆盖 {totals.covered}</span>
        <span>问题 {totals.issue}</span>
        <span>风险 {totals.risk}</span>
        <span>疑问 {totals.question}</span>
        {totals.important ? <span className="major">重要 {totals.important}</span> : null}
      </div>
      <div className="ledger-groups">
        {[...grouped.entries()].map(([dimensionId, dimensionItems]) => (
          <LedgerSectionCard
            defaultOpen={dimensionItems.some((item) => item.severity === 'critical' || item.severity === 'major')}
            description="按执行过程中沉淀的结构化条目汇总"
            frame={frame}
            items={dimensionItems}
            key={dimensionId}
            limit={24}
            title={dimensionLabel(frame, dimensionId)}
          />
        ))}
      </div>
    </section>
  );
}

function ReportEvidence({ run }: { run: TestRunRecord }) {
  return (
    <div className="report-evidence">
      <section>
        <h3>运行日志</h3>
        <ReportAccordion title="Console 错误" items={run.result?.consoleErrors || []} />
        <ReportAccordion title="网络异常" items={run.result?.networkErrors || []} />
      </section>
    </div>
  );
}

export function RunProgress({
  browserMode = 'default',
  initialRun,
  testCaseTitle = '未知用例',
}: {
  browserMode?: TestCaseContent['browserMode'];
  initialRun: TestRunRecord;
  testCaseTitle?: string;
}) {
  const { t } = useI18n();
  const [run, setRun] = useState(initialRun);
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(() => initialRun.result?.steps.at(-1)?.index);
  const [imagePreview, setImagePreview] = useState<{ images: ImageItem[]; index: number } | null>(null);
  const [domTreeDialog, setDomTreeDialog] = useState<{ domTree: string; stepIndex: number; toolIndex: number; toolName: string } | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [expandedToolCards, setExpandedToolCards] = useState<Record<string, boolean>>({});
  const [resumePendingStep, setResumePendingStep] = useState<number | undefined>();
  const [editingToolsStepIndex, setEditingToolsStepIndex] = useState<number | undefined>();
  const [toolDrafts, setToolDrafts] = useState<ToolDraft[]>([]);
  const [toolEditError, setToolEditError] = useState('');
  const [savingTools, setSavingTools] = useState(false);
  const [replayingRecord, setReplayingRecord] = useState(false);
  const steps = useMemo(() => run.result?.steps || [], [run.result?.steps]);
  const allImages = useMemo(() => collectStepImages(steps, t), [steps, t]);
  const taskFrame = useMemo(() => collectRunTaskFrame(run), [run]);
  const ledgerItems = useMemo(() => collectRunLedgerItems(run), [run]);
  const selectedStep = selectedOrLatest(steps, selectedIndex);
  const editorMode = inferModeFromStep(selectedStep) || normalizeEditorMode(browserMode) || 'dom';
  const editableToolNames = useMemo(() => toolNamesForMode(editorMode), [editorMode]);
  const runningStep = steps.find((step) => step.status === 'running');
  const debugEnabled = Boolean(run.debug?.enabled);
  const manualIntervention = run.control?.manualIntervention;
  const visibleManualIntervention = manualIntervention?.stepIndex === resumePendingStep ? undefined : manualIntervention;
  const manualInterventionScreenshotUrl = artifactUrl(visibleManualIntervention?.screenshotPath);
  const canPause = run.status === 'running' || run.status === 'queued';
  const canResumeRun = run.status === 'paused';
  const canContinueBlockedRun = run.status === 'blocked';
  const canEditToolRecord = selectedStep && run.status !== 'running' && run.status !== 'queued' && run.status !== 'paused';
  const canRunByRecord = isFinished(run.status) && steps.some((step) => step.tools?.some((tool) => tool.ok !== false));

  useEffect(() => {
    let active = true;
    let refreshTimer: number | undefined;
    let refreshInFlight: Promise<void> | undefined;
    let websocketConnected = false;

    const stopRealtime = () => {
      active = false;
      window.clearInterval(timer);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };

    const refreshRun = async () => {
      if (!active) return undefined;
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = (async () => {
        const response = await fetch(`/api/runs/${run.id}`, { cache: 'no-store' });
        if (!response.ok || !active) {
          if (response.status === 404) stopRealtime();
          return;
        }
        const latest = (await response.json()) as TestRunRecord;
        setRun(latest);
        if (isFinished(latest.status) && latest.report?.markdown) stopRealtime();
      })().finally(() => {
        refreshInFlight = undefined;
      });
      return refreshInFlight;
    };

    const scheduleRefresh = (delay = 30) => {
      if (!active) return;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refreshRun();
      }, delay);
    };

    const unsubscribe = subscribeRealtimeRefresh((event) => {
      if (!active) return;
      if (event.entityType !== 'run' || event.id !== run.id) return;
      if (event.deleted) {
        stopRealtime();
        return;
      }
      scheduleRefresh();
    }, {
      onStatus: (connected) => {
        websocketConnected = connected;
        if (connected) scheduleRefresh();
      },
    });

    const timer = window.setInterval(() => {
      if (!websocketConnected) void refreshRun();
    }, 1000);
    void refreshRun();

    return () => {
      unsubscribe();
      stopRealtime();
    };
  }, [run.id]);

  useEffect(() => {
    const latest = steps.at(-1)?.index;
    if (!latest) return;
    setSelectedIndex((current) => current || latest);
  }, [steps]);

  useEffect(() => {
    if (!manualIntervention || manualIntervention.stepIndex !== resumePendingStep) setResumePendingStep(undefined);
  }, [manualIntervention, resumePendingStep]);

  useEffect(() => {
    setRequestOpen(false);
  }, [selectedStep?.index]);

  useEffect(() => {
    if (!editingToolsStepIndex) return;
    if (selectedStep?.index === editingToolsStepIndex) return;
    setEditingToolsStepIndex(undefined);
    setToolDrafts([]);
    setToolEditError('');
  }, [editingToolsStepIndex, selectedStep?.index]);

  const progressText = useMemo(() => {
    if (run.status === 'paused') return t('AI 测试已暂停');
    if (!steps.length) return run.status === 'running' ? t('AI 正在启动浏览器') : t('暂无执行步骤');
    if (runningStep) return t('正在记录步骤 {index}', { index: runningStep.index });
    return t('已记录 {count} 个操作', { count: steps.length });
  }, [run.status, runningStep, steps.length, t]);

  function openImageByUrl(url: string) {
    const images = allImages.some((image) => image.url === url) ? allImages : [...allImages, { title: '当前截图', url }];
    const index = images.findIndex((image) => image.url === url);
    setImagePreview({ images, index: Math.max(index, 0) });
  }

  function openToolScreenshots(images: ImageItem[]) {
    if (!images.length) return;
    setImagePreview({ images, index: 0 });
  }

  function toolCardKey(step: StepExecutionResult, tool: StepToolCallItem, index: number) {
    return `${step.index}:${index}:${tool.name}`;
  }

  function isToolCardExpanded(step: StepExecutionResult, tool: StepToolCallItem, index: number) {
    const key = toolCardKey(step, tool, index);
    return expandedToolCards[key] ?? tool.ok !== true;
  }

  function toggleToolCard(step: StepExecutionResult, tool: StepToolCallItem, index: number) {
    const key = toolCardKey(step, tool, index);
    const current = isToolCardExpanded(step, tool, index);
    setExpandedToolCards((state) => ({ ...state, [key]: !current }));
  }

  function beginToolRecordEdit(step: StepExecutionResult) {
    setEditingToolsStepIndex(step.index);
    setToolDrafts((step.tools || []).map(toolDraftFromCall));
    setToolEditError('');
  }

  function cancelToolRecordEdit() {
    setEditingToolsStepIndex(undefined);
    setToolDrafts([]);
    setToolEditError('');
  }

  function updateToolDraft(index: number, patch: Partial<ToolDraft>) {
    setToolDrafts((current) => current.map((tool, toolIndex) => (
      toolIndex === index ? { ...tool, ...patch } : tool
    )));
  }

  function updateToolDraftName(index: number, name: string) {
    setToolDrafts((current) => current.map((tool, toolIndex) => {
      if (toolIndex !== index) return tool;
      return {
        ...tool,
        name,
        inputText: toolTemplateText(name),
        sourceToolIndex: undefined,
      };
    }));
  }

  function addToolDraft() {
    const defaultName = editableToolNames.includes('waitForPage') ? 'waitForPage' : editableToolNames[0] || 'waitForPage';
    setToolDrafts((current) => [...current, newToolDraft(defaultName)]);
  }

  function removeToolDraft(index: number) {
    setToolDrafts((current) => current.filter((_, toolIndex) => toolIndex !== index));
  }

  function moveToolDraft(index: number, direction: -1 | 1) {
    setToolDrafts((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function parseToolDraftsForSave() {
    return toolDrafts.map((tool, index): ToolRecordSavePayload => {
      const name = tool.name.trim();
      if (!name) throw new Error(t('第 {index} 个工具缺少工具名', { index: index + 1 }));

      const rawInput = tool.inputText.trim();
      let parsedInput: unknown | undefined;
      if (rawInput) {
        try {
          parsedInput = JSON.parse(rawInput);
        } catch {
          throw new Error(t('第 {index} 个工具参数不是合法 JSON', { index: index + 1 }));
        }
        if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
          throw new Error(t('第 {index} 个工具参数必须是 JSON 对象', { index: index + 1 }));
        }
      }

      return {
        name,
        input: parsedInput,
        reason: tool.reason?.trim() || undefined,
        ok: toolOkFromDraft(tool.okState),
        sourceToolIndex: tool.sourceToolIndex,
        contextBefore: tool.contextBefore,
        contextAfter: tool.contextAfter,
        visualAfter: tool.visualAfter,
        desktopEvidence: tool.desktopEvidence,
        screenshots: tool.screenshots,
      };
    });
  }

  async function saveToolRecordEdit() {
    if (!selectedStep || savingTools) return;
    let tools: ToolRecordSavePayload[];
    try {
      tools = parseToolDraftsForSave();
    } catch (error) {
      setToolEditError(error instanceof Error ? error.message : t('工具记录配置无效'));
      return;
    }

    setSavingTools(true);
    setToolEditError('');
    startGlobalLoading(t('正在保存工具记录'));
    try {
      const response = await fetch(`/api/runs/${run.id}/steps/${selectedStep.index}/tools`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools }),
      });
      const data = await response.json();
      if (!response.ok || !data.run) throw new Error(data.error || t('保存工具记录失败'));
      setRun(data.run as TestRunRecord);
      cancelToolRecordEdit();
    } catch (error) {
      setToolEditError(error instanceof Error ? error.message : t('保存工具记录失败'));
    } finally {
      setSavingTools(false);
      stopGlobalLoading();
    }
  }

  async function runByCurrentRecord() {
    if (!canRunByRecord || replayingRecord) return;
    setReplayingRecord(true);
    startGlobalLoading(t('正在按记录执行'));
    try {
      const response = await fetch(`/api/runs/${run.id}/replay`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.runId) throw new Error(data.error || t('按记录执行失败'));
      window.location.href = `/runs/${data.runId}`;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('按记录执行失败'));
      setReplayingRecord(false);
      stopGlobalLoading();
    }
  }

  async function skipSelectedStep() {
    if (!selectedStep) return;
    startGlobalLoading(t('正在跳过步骤'));
    try {
      const response = await fetch(`/api/runs/${run.id}/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: selectedStep.index }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function pauseRun() {
    if (!canPause) return;
    startGlobalLoading(t('正在暂停运行'));
    try {
      const response = await fetch(`/api/runs/${run.id}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: runningStep?.index || selectedStep?.index }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function resumeRun() {
    if (!canResumeRun) return;
    startGlobalLoading(t('正在继续运行'));
    try {
      const response = await fetch(`/api/runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: run.control?.pauseStepIndex || runningStep?.index || selectedStep?.index }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function continueBlockedRun() {
    if (!canContinueBlockedRun) return;
    startGlobalLoading(t('正在继续运行'));
    try {
      const response = await fetch(`/api/runs/${run.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function resumeManualIntervention() {
    if (!manualIntervention) return;
    setResumePendingStep(manualIntervention.stepIndex);
    startGlobalLoading(t('正在恢复人工校验'));
    try {
      const response = await fetch(`/api/runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: manualIntervention.stepIndex }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
      else setResumePendingStep(undefined);
    } finally {
      stopGlobalLoading();
    }
  }

  return (
    <div className="test-cockpit">
      <div className="cockpit-toolbar">
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <span>{progressText}</span>
          <span>{t('{count} 条操作', { count: steps.length })}</span>
          {run.report?.markdown ? (
            <button className="link-button" onClick={() => setReportOpen(true)} type="button">
              {t('查看最终报告')}
            </button>
          ) : null}
          <RunScreenshotChainButton className="link-button" label={t('查看截图链')} run={run} />
          {isFinished(run.status) ? (
            <a className="link-button" href={`/api/runs/${run.id}/pdf`} target="_blank">
              {t('导出 PDF')}
            </a>
          ) : null}
          {traceUrl(run) ? (
            <a className="link-button" href={traceUrl(run)} target="_blank">
              {t('下载 Trace')}
            </a>
          ) : null}
          {isFinished(run.status) && steps.some((step) => step.tools?.some((tool) => tool.ok !== false)) ? (
            <a className="link-button" href={`/api/runs/${run.id}/recorded-flow`} target="_blank">
              {t('导出录制流')}
            </a>
          ) : null}
          {canRunByRecord ? (
            <button className="link-button" disabled={replayingRecord} onClick={runByCurrentRecord} type="button">
              {replayingRecord ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
              {t('按记录执行')}
            </button>
          ) : null}
          {debugEnabled ? (
            <span className="debug-phase">
              <Bug size={14} />
              {run.debug?.phase || 'debug'}
              {run.debug?.stepIndex ? ` · ${t('步骤 {index}', { index: run.debug.stepIndex })}` : ''}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "16px" }}>
          {canPause ? (
            <button className="link-button" onClick={pauseRun} type="button">
              <PauseCircle size={16} />
              {t('暂停')}
            </button>
          ) : null}
          {canResumeRun ? (
            <button className="link-button" onClick={resumeRun} type="button">
              <PlayCircle size={16} />
              {t('继续')}
            </button>
          ) : null}
          {canContinueBlockedRun ? (
            <button className="link-button" onClick={continueBlockedRun} type="button">
              <PlayCircle size={16} />
              {t('继续运行')}
            </button>
          ) : null}
          <RunMetaDrawer run={run} testCaseTitle={testCaseTitle} />
          <span className={`run-status-large status-${run.status}`}>
            <Radar size={18} />
            {t(statusLabel(run.status))}
          </span>
        </div>
      </div>

      {visibleManualIntervention ? (
        <div className="manual-intervention-banner">
          <div>
            <strong>{t('需要人工介入')}</strong>
            <p>{visibleManualIntervention.reason}</p>
          </div>
          <div className="manual-intervention-actions">
            {manualInterventionScreenshotUrl ? (
              <button className="link-button" onClick={() => openImageByUrl(manualInterventionScreenshotUrl)} type="button">
                <Eye size={14} />
                {t('查看当前截图')}
              </button>
            ) : null}
            <button className="link-button" onClick={resumeManualIntervention} type="button">
              <CheckCircle2 size={16} />
              {t('执行完毕')}
            </button>
          </div>
        </div>
      ) : null}

      <section className="cockpit-body">
        <aside className="step-rail" aria-label={t('执行步骤')}>
          {steps.map((step) => {
            const badges = stepToolBadges(step);
            const visibleBadges = badges.slice(0, 4);
            const hiddenBadgeCount = Math.max(0, badges.length - visibleBadges.length);
            const toolPopover = badges.map((badge) => toolBadgeLabel(badge, t)).join(' · ');
            return (
              <button className={selectedStep?.index === step.index ? 'rail-step active' : 'rail-step'} key={step.index} onClick={() => setSelectedIndex(step.index)} type="button">
                <span className="rail-icon"><StepIcon status={step.status} /></span>
                <span className="rail-copy">
                  <strong>{step.action}</strong>
                  <small className="rail-step-meta">
                    <span>{t('步骤 {index}', { index: step.index })}</span>
                    {visibleBadges.length ? (
                      <span className="rail-tool-chips" aria-label={t('工具：{names}', { names: badges.map((badge) => badge.name).join('、') })}>
                        {visibleBadges.map((badge) => (
                          <span className={badge.ok === false ? 'rail-tool-chip failed' : 'rail-tool-chip'} key={badge.name} title={badge.name}>
                            {toolBadgeLabel(badge, t)}
                          </span>
                        ))}
                        {hiddenBadgeCount ? <span className="rail-tool-chip muted">+{hiddenBadgeCount}</span> : null}
                      </span>
                    ) : null}
                  </small>
                  {toolPopover ? <span className="rail-tool-popover" role="tooltip">{toolPopover}</span> : null}
                </span>
              </button>
            );
          })}
        </aside>

        <article className="evidence-panel">
          {selectedStep ? (
            <>
              <header className="evidence-title">
                <div>
                  <span className="rail-icon"><StepIcon status={selectedStep.status} /></span>
                  <div>
                    <h3>{selectedStep.action}</h3>
                    <p>{t('步骤 {index}', { index: selectedStep.index })}</p>
                  </div>
                </div>
                <div className="evidence-actions">
                  {selectedStep.aiRequest ? (
                    <button className="link-button" onClick={() => setRequestOpen(true)} type="button">
                      <Bug size={14} />
                      {t('查看请求内容')}
                    </button>
                  ) : null}
                  {selectedStep.status === 'running' ? (
                    <button className="text-danger-button" onClick={skipSelectedStep} type="button">
                      <SkipForward size={15} />
                      {t('跳过当前步骤')}
                    </button>
                  ) : null}
                </div>
              </header>
              <dl className="evidence-properties">
                <div>
                  <dt>{t('AI 操作')}</dt>
                  <dd><EvidenceMarkdown markdown={selectedStep.action} /></dd>
                </div>
                {visibleStepObservation(selectedStep) ? (
                  <div>
                    <dt>{t('页面观察')}</dt>
                    <dd><EvidenceMarkdown markdown={visibleStepObservation(selectedStep) || ''} /></dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t('重要发现')}</dt>
                  <dd>
                    {selectedStep.findings?.length ? (
                      <ul className="compact-bullet-list">
                        {selectedStep.findings.map((item, index) => <li key={index}>{item}</li>)}
                      </ul>
                    ) : (
                      t('暂无发现')
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('工具调用')}</dt>
                  <dd>
                    {canEditToolRecord ? (
                      <div className="tool-record-toolbar">
                        {editingToolsStepIndex === selectedStep.index ? (
                          <>
                            <button className="icon-text-button tool-record-action primary" disabled={savingTools} onClick={saveToolRecordEdit} type="button">
                              {savingTools ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                              {t('保存工具记录')}
                            </button>
                            <button className="icon-text-button tool-record-action" disabled={savingTools} onClick={cancelToolRecordEdit} type="button">
                              <X size={14} />
                              {t('取消')}
                            </button>
                          </>
                        ) : (
                          <button className="icon-text-button tool-record-action" onClick={() => beginToolRecordEdit(selectedStep)} type="button">
                            <Wrench size={14} />
                            {t('编辑工具记录')}
                          </button>
                        )}
                      </div>
                    ) : null}
                    {editingToolsStepIndex === selectedStep.index ? (
                      <div className="run-tool-editor">
                        {toolEditError ? <div className="error compact-error">{toolEditError}</div> : null}
                        <div className="run-tool-editor-mode">
                          <span>{toolModeLabel(editorMode, t)}</span>
                          <small>{t('工具列表已按当前执行模式过滤，AI 文本生成仅用于编辑后的记录回放。')}</small>
                        </div>
                        <ol className="run-tool-editor-list">
                          {toolDrafts.map((tool, index) => (
                            <li className="run-tool-editor-item" key={tool.draftId}>
                              <div className="run-tool-editor-head">
                                <span className="run-tool-editor-index">{index + 1}</span>
                                <label>
                                  {t('工具名')}
                                  <CustomSelect
                                    className="run-tool-name-select"
                                    disabled={savingTools}
                                    options={Array.from(new Set([tool.name, ...editableToolNames].filter(Boolean))).map((name) => ({ label: toolOptionLabel(name, t), value: name }))}
                                    value={tool.name}
                                    onChange={(value) => updateToolDraftName(index, value)}
                                  />
                                </label>
                                <label>
                                  {t('状态')}
                                  <CustomSelect
                                    className="run-tool-status-select"
                                    disabled={savingTools}
                                    options={toolStatusOptions.map((option) => ({ ...option, label: t(option.label) }))}
                                    value={tool.okState}
                                    onChange={(value) => updateToolDraft(index, { okState: value as ToolDraftStatus })}
                                  />
                                </label>
                                <div className="run-tool-editor-actions">
                                  <button
                                    aria-label={t('上移')}
                                    className="icon-button"
                                    disabled={index === 0 || savingTools}
                                    onClick={() => moveToolDraft(index, -1)}
                                    title={t('上移')}
                                    type="button"
                                  >
                                    <ArrowUp size={14} />
                                  </button>
                                  <button
                                    aria-label={t('下移')}
                                    className="icon-button"
                                    disabled={index === toolDrafts.length - 1 || savingTools}
                                    onClick={() => moveToolDraft(index, 1)}
                                    title={t('下移')}
                                    type="button"
                                  >
                                    <ArrowDown size={14} />
                                  </button>
                                  <button
                                    aria-label={t('删除工具')}
                                    className="icon-button danger"
                                    disabled={savingTools}
                                    onClick={() => removeToolDraft(index)}
                                    title={t('删除工具')}
                                    type="button"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                              <div className="run-tool-editor-grid">
                                <ToolParameterEditor
                                  disabled={savingTools}
                                  tool={tool}
                                  onChange={(inputText) => updateToolDraft(index, { inputText, sourceToolIndex: undefined })}
                                />
                                <label>
                                  {t('调用原因')}
                                  <textarea
                                    className="textarea compact run-tool-reason-textarea"
                                    value={tool.reason || ''}
                                    onChange={(event) => updateToolDraft(index, { reason: event.target.value })}
                                  />
                                </label>
                              </div>
                              {selectedStep ? (
                                <ToolDraftEvidenceButtons
                                  index={index}
                                  openDomTree={setDomTreeDialog}
                                  openScreenshots={openToolScreenshots}
                                  step={selectedStep}
                                  tool={tool}
                                />
                              ) : null}
                            </li>
                          ))}
                        </ol>
                        <button className="icon-text-button add-step-button" disabled={savingTools} onClick={addToolDraft} type="button">
                          <Plus size={15} />
                          {t('新增工具调用')}
                        </button>
                      </div>
                    ) : selectedStep.tools?.length ? (
                      <ol className="tool-call-list">
                        {selectedStep.tools.map((tool, index) => (
                          <ToolCallCard
                            expanded={isToolCardExpanded(selectedStep, tool, index)}
                            index={index}
                            key={`${tool.name}-${index}`}
                            onToggle={() => toggleToolCard(selectedStep, tool, index)}
                            openImage={openImageByUrl}
                            step={selectedStep}
                            tool={tool}
                          />
                        ))}
                      </ol>
                    ) : (
                      t('本步未调用浏览器工具')
                    )}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <div className="empty-state">{t('等待 AI 写入第一条执行记录。')}</div>
          )}
        </article>
      </section>

      <LedgerPanel frame={taskFrame} items={ledgerItems} />

      {debugEnabled ? (
        <section className="debug-timeline">
          <div className="section-head"><div><h2>Debug 流程</h2><p>显示 AI 请求响应、工具调用、工具结果和当前卡住阶段。</p></div></div>
          <ol>
            {(run.debug?.events || []).slice(-80).map((event, index) => (
              <DebugEventRow event={event} key={`${event.time}-${index}`} />
            ))}
          </ol>
        </section>
      ) : null}

      {reportOpen && run.report?.markdown ? (
        <div className="modal-overlay" onClick={() => setReportOpen(false)} role="presentation">
          <section className="report-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('最终报告')}>
            <header>
              <h2>{t('最终报告')}</h2>
              <button className="icon-button" onClick={() => setReportOpen(false)} type="button" aria-label={t('关闭')}><X size={18} /></button>
            </header>
            <ReportEvidence run={run} />
            <MarkdownReport markdown={run.report.markdown} onImageClick={openImageByUrl} />
          </section>
        </div>
      ) : null}

      {requestOpen && selectedStep?.aiRequest ? (
        <div className="modal-overlay" onClick={() => setRequestOpen(false)} role="presentation">
          <section className="report-modal ai-request-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('AI 请求内容')}>
            <header>
              <h2>{t('AI 请求内容')} · {t('步骤 {index}', { index: selectedStep.index })}</h2>
              <button className="icon-button" onClick={() => setRequestOpen(false)} type="button" aria-label={t('关闭')}><X size={18} /></button>
            </header>
            <pre className="ai-request-pre">{JSON.stringify(selectedStep.aiRequest, null, 2)}</pre>
          </section>
        </div>
      ) : null}

      {domTreeDialog ? (
        <div className="modal-overlay" onClick={() => setDomTreeDialog(null)} role="presentation">
          <section className="report-modal dom-tree-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('DOM 树')}>
            <header>
              <div>
                <h2>{t('DOM 树')}</h2>
                <p>{t('步骤 {index}', { index: domTreeDialog.stepIndex })} · {domTreeDialog.toolName} · #{domTreeDialog.toolIndex + 1}</p>
              </div>
              <button className="icon-button" onClick={() => setDomTreeDialog(null)} type="button" aria-label={t('关闭')}><X size={18} /></button>
            </header>
            <pre className="dom-tree-pre">{domTreeDialog.domTree}</pre>
          </section>
        </div>
      ) : null}

      {imagePreview ? (
        <ImageViewer images={imagePreview.images} initialIndex={imagePreview.index} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
  );
}
