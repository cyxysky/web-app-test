'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { formatToolPayload } from '@/components/browser-chat-format';
import { browserChatToolFailureSummary } from '@/components/browser-chat-tool-error';
import { useI18n } from '@/i18n/I18nProvider';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { AppModal } from '@/components/ui/app-modal';

type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

export type BrowserChatToolDialogDetail = {
  confirmationScreenshotUrl?: string;
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

function toolStatusLabel(tool: BrowserChatToolCall, step: StepExecutionResult) {
  if (tool.recovered === true && tool.transient === true) return '已恢复';
  if (tool.ok === true) return '已完成';
  if (tool.ok === false) return '失败';
  if (step.status === 'failed') return '失败';
  if (step.status === 'blocked') return '已暂停';
  if (step.status === 'passed') return '已完成';
  return '执行中';
}

function toolStatusTone(status: string) {
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

function rawToolResultPayload(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  onClose,
  toolLabel,
}: {
  detail: BrowserChatToolDialogDetail;
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
  const completeResult = detail.tool.rawResult ?? detail.tool.result;
  const hasActualResult = completeResult !== undefined && completeResult !== null && completeResult !== '';
  // Diagnostics must expose the exact persisted tool result. In particular,
  // do not unwrap `actual`: the outer result also carries runtime Skills,
  // failure classification, screenshots, and trace data.
  const resultPayload = rawToolResultPayload(completeResult);
  const failureSummary = status === '失败'
    ? browserChatToolFailureSummary(completeResult)
    : undefined;

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
          {failureSummary ? <div className="browser-chat-tool-failure-summary" role="alert">{failureSummary}</div> : null}
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
              {hasActualResult ? <ToolOutputViewer payload={resultPayload || emptyPayloadLabel} wrap={wrapOutput} /> : <ToolOutputViewer payload={t('该工具调用没有返回执行结果。')} wrap={wrapOutput} />}
            </section>
          </div>
        </div>
    </AppModal>
  );
}
