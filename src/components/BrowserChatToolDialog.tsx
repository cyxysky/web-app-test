'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { formatToolPayload } from '@/lib/browser-chat-format';
import { useI18n } from '@/i18n/I18nProvider';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { AppModal } from '@/components/ui/app-modal';
import { browserChatToolOutcomeLabel } from '@/components/browser-chat-tool-error';

type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

export type BrowserChatToolDialogDetail = {
  confirmationScreenshotUrl?: string;
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

function toolStatusLabel(tool: BrowserChatToolCall, step: StepExecutionResult) {
  const outcome = browserChatToolOutcomeLabel(tool.rawResult ?? tool.error ?? tool.result);
  if (outcome) return outcome;
  if (tool.recovered === true && tool.transient === true) return '已恢复';
  if (tool.ok === true) return '已完成';
  if (tool.ok === false) return '失败';
  if (step.status === 'failed') return '失败';
  if (step.status === 'blocked') return '已暂停';
  if (step.status === 'passed') return '已完成';
  return '执行中';
}

function toolStatusTone(status: string) {
  if (status.includes('校验失败') || status.includes('仍有冲突')) return 'warning';
  if (status === '失败') return 'danger';
  if (status === '已暂停') return 'warning';
  if (status === '执行中') return 'progress';
  return 'success';
}

function highlightedPayloadLine(line: string, lineIndex: number): ReactNode[] {
  const tokenPattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(line)) !== null) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const tone = match[1]
      ? 'key'
      : match[2]
        ? 'string'
        : match[3]
          ? 'number'
          : match[4] === 'null'
            ? 'null'
            : 'boolean';
    nodes.push(
      <span className={`browser-chat-tool-code-token is-${tone}`} key={`${lineIndex}-${match.index}`}>
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes.length ? nodes : [' '];
}

function ToolOutputViewer({ payload, wrap }: { payload: string; wrap: boolean }) {
  return (
    <div className={`browser-chat-tool-output-viewer${wrap ? ' is-wrapped' : ''}`} role="region" tabIndex={0}>
      <div className="browser-chat-tool-output-code">
        {payload.split('\n').map((line, index) => (
          <div className="browser-chat-tool-output-line" key={`${index}-${line}`}>
            <span aria-hidden="true" className="browser-chat-tool-output-line-number">{index + 1}</span>
            <code>{highlightedPayloadLine(line, index)}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function toolInputPayload(tool: BrowserChatToolCall) {
  if (!tool.reason) return formatToolPayload(tool.input);
  const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
    ? tool.input as Record<string, unknown>
    : tool.input === undefined
      ? {}
      : { input: tool.input };
  return formatToolPayload({ ...input, reason: tool.reason });
}

export function BrowserChatToolDialog({
  detail,
  loading = false,
  loadFailed = false,
  onRetry,
  onClose,
  toolLabel,
}: {
  detail: BrowserChatToolDialogDetail;
  loading?: boolean;
  loadFailed?: boolean;
  onRetry?: () => void;
  onClose: () => void;
  toolLabel: (name: string, input: unknown) => string;
}) {
  const { t } = useI18n();
  const [wrapInput, setWrapInput] = useState(true);
  const [wrapOutput, setWrapOutput] = useState(true);
  const [copiedPayload, setCopiedPayload] = useState<'input' | 'output' | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolName = toolLabel(detail.tool.name, detail.tool.input);
  const status = toolStatusLabel(detail.tool, detail.step);
  const emptyPayloadLabel = t('无');
  // Tool traces store the semantic reason separately from `input`. Recombine
  // them here so two calls that differ only by a missing reason do not look
  // identical in the diagnostics dialog.
  const inputPayload = toolInputPayload(detail.tool);
  const displayedInputPayload = inputPayload || emptyPayloadLabel;
  const completeResult = detail.tool.rawResult ?? detail.tool.error ?? detail.tool.result;
  const hasActualResult = completeResult !== undefined && completeResult !== null && completeResult !== '';
  // Keep the complete persisted result while expanding any embedded JSON text
  // into structured values for the JSON viewer.
  const resultPayload = formatToolPayload(completeResult);
  const missingResultLabel = loading
    ? '正在加载完整执行结果…'
    : loadFailed
      ? '完整执行结果加载失败，请重试。'
      : detail.tool.ok === undefined && detail.step.status === 'running'
        ? '工具正在执行，尚未返回结果。'
        : '此调用已结束，但记录中缺少执行结果。';
  useEffect(() => () => {
    if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current);
  }, []);

  const copyPayload = async (payload: string, target: 'input' | 'output') => {
    if (!payload || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedPayload(target);
      if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(() => {
        setCopiedPayload((current) => current === target ? null : current);
      }, 1600);
    } catch {
      setCopiedPayload(null);
    }
  };

  return (
    <AppModal
      ariaLabelledBy="browser-chat-tool-dialog-title"
      backdropClassName="browser-chat-tool-dialog-overlay"
      dialogClassName="browser-chat-tool-dialog"
      onClose={onClose}
      size="log"
    >
        <header className="ui-modal-header browser-chat-tool-dialog-header">
          <div className="ui-modal-heading">
            <h2 className="ui-modal-title browser-chat-tool-dialog-tab" id="browser-chat-tool-dialog-title" title={detail.tool.name}>{toolName}</h2>
            <div className="browser-chat-tool-dialog-subtitle">
              <p className="ui-modal-subtitle">
                {t('步骤 {step} · 工具调用 {index}', { step: detail.stepIndex, index: detail.toolIndex + 1 })}
              </p>
              <span className={`browser-chat-tool-status is-${toolStatusTone(status)}`}>{t(status)}</span>
            </div>
          </div>
          <button className="ui-icon-button ui-modal-close" onClick={onClose} type="button" aria-label={t('关闭')}>
            <X size={18} />
          </button>
        </header>

        <div className="ui-modal-body browser-chat-tool-modal-body">
          <div className="browser-chat-tool-io-grid">
            <section className="browser-chat-tool-output-panel">
              <header className="browser-chat-tool-output-header">
                <h3>{t('输入参数')}</h3>
                <div className="browser-chat-tool-output-actions">
                  <span className="browser-chat-tool-output-format">JSON</span>
                  <span>{t('自动换行')}</span>
                  <button aria-checked={wrapInput} aria-label={t('切换自动换行')} className="browser-chat-tool-wrap-toggle" onClick={() => setWrapInput((current) => !current)} role="switch" type="button"><span /></button>
                  <button className="browser-chat-tool-copy-button" onClick={() => void copyPayload(displayedInputPayload, 'input')} type="button">{copiedPayload === 'input' ? <Check size={15} /> : <Copy size={15} />}{t(copiedPayload === 'input' ? '已复制' : '复制')}</button>
                </div>
              </header>
              <ToolOutputViewer payload={displayedInputPayload} wrap={wrapInput} />
            </section>
            <section className="browser-chat-tool-output-panel">
              <header className="browser-chat-tool-output-header">
                <h3>{t('输出结果')}</h3>
                <div className="browser-chat-tool-output-actions">
                  <span className="browser-chat-tool-output-format">JSON</span>
                  <span>{t('自动换行')}</span>
                  <button aria-checked={wrapOutput} aria-label={t('切换自动换行')} className="browser-chat-tool-wrap-toggle" onClick={() => setWrapOutput((current) => !current)} role="switch" type="button"><span /></button>
                  {hasActualResult ? <button className="browser-chat-tool-copy-button" onClick={() => void copyPayload(resultPayload, 'output')} type="button">{copiedPayload === 'output' ? <Check size={15} /> : <Copy size={15} />}{t(copiedPayload === 'output' ? '已复制' : '复制')}</button> : null}
                </div>
              </header>
              {loading && hasActualResult ? <p role="status">{t('正在加载完整执行结果…')}</p> : null}
              {loadFailed ? <p role="alert">{t('完整执行结果加载失败，请重试。')} {onRetry ? <button onClick={onRetry} type="button">{t('重试')}</button> : null}</p> : null}
              <ToolOutputViewer payload={hasActualResult ? resultPayload || emptyPayloadLabel : t(missingResultLabel)} wrap={wrapOutput} />
            </section>
          </div>
        </div>
    </AppModal>
  );
}
