'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { formatToolPayload } from '@/components/browser-chat-format';
import { useI18n } from '@/i18n/I18nProvider';
import { artifactApiUrl } from '@/lib/artifacts';
import { browserChatScreenshotIsInternalDocumentPreview } from '@/lib/browser-chat-artifacts';
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

function screenshotKindLabel(kind?: string) {
  if (kind === 'original') return '原始图';
  if (kind === 'marker') return '标识图';
  if (kind === 'current' || kind === 'pinned' || kind === 'after') return '操作后';
  if (kind === 'history') return '操作前';
  return '截图';
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

function toolResultPayload(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'actual' in value) {
    const actual = (value as { actual?: unknown }).actual;
    if (typeof actual === 'string') return actual;
  }
  return formatToolPayload(value);
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
  const inputPayload = formatToolPayload(detail.tool.input);
  const displayedInputPayload = inputPayload || emptyPayloadLabel;
  const completeResult = detail.tool.rawResult ?? detail.tool.result;
  const hasActualResult = completeResult !== undefined && completeResult !== null && completeResult !== '';
  // The trace retains the structured BrowserActionResult. Show its actual
  // payload directly so reflection/read output is visible, rather than making
  // the user hunt through a wrapper object's `actual` field.
  const resultPayload = toolResultPayload(completeResult);
  const visibleScreenshots = (detail.tool.screenshots || []).filter((screenshot) => (
    !browserChatScreenshotIsInternalDocumentPreview(detail.tool.name, screenshot)
  ));

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
              {hasActualResult ? <ToolOutputViewer payload={resultPayload || emptyPayloadLabel} wrap={wrapOutput} /> : <ToolOutputViewer payload={t('该工具调用没有返回执行结果。')} wrap={wrapOutput} />}
            </section>
          </div>

          {detail.confirmationScreenshotUrl || visibleScreenshots.length ? (
            <section className="browser-chat-tool-detail-section browser-chat-tool-screenshots">
              <h3>{t('截图记录')}</h3>
              <div className="browser-chat-tool-shot-grid">
                {detail.confirmationScreenshotUrl ? <a className="browser-chat-tool-shot-card" href={detail.confirmationScreenshotUrl} rel="noopener noreferrer" target="_blank"><img alt={t('用户确认时的页面截图')} src={detail.confirmationScreenshotUrl} /><span><strong>{t('操作前确认截图')}</strong><code>{detail.confirmationScreenshotUrl}</code></span></a> : null}
                {visibleScreenshots.map((shot, index) => {
                  const url = artifactApiUrl(shot.path);
                  return <a className="browser-chat-tool-shot-card" href={url || '#'} key={`${shot.path}-${index}-preview`} onClick={(event) => { if (!url) event.preventDefault(); }} rel="noopener noreferrer" target="_blank">{url ? <img alt={shot.title || t(screenshotKindLabel(shot.kind))} src={url} /> : null}<span><strong>{t(screenshotKindLabel(shot.kind))} · {shot.title || t('截图 {index}', { index: index + 1 })}</strong><code>{shot.path}</code></span></a>;
                })}
              </div>
            </section>
          ) : null}
        </div>
    </AppModal>
  );
}
