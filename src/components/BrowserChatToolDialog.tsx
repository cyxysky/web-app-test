'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { BrowserChatPayloadDetails } from '@/components/BrowserChatPayloadDetails';
import { formatToolPayload } from '@/components/browser-chat-format';
import { useI18n } from '@/i18n/I18nProvider';
import { artifactApiUrl } from '@/lib/artifacts';
import { useEscapeDismiss } from '@/hooks/useEscapeDismiss';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';

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

function compactPayloadPreview(value: unknown, emptyLabel: string, max = 180) {
  const text = formatToolPayload(value).replace(/\s+/g, ' ').trim();
  if (!text) return emptyLabel;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

export function BrowserChatToolDialog({
  detail,
  onClose,
  toolLabel,
}: {
  detail: BrowserChatToolDialogDetail;
  onClose: () => void;
  toolLabel: (name: string) => string;
}) {
  const { t } = useI18n();
  const [wrapOutput, setWrapOutput] = useState(true);
  const [copied, setCopied] = useState(false);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEscapeDismiss(true, onClose);
  const toolName = toolLabel(detail.tool.name);
  const status = toolStatusLabel(detail.tool, detail.step);
  const emptyPayloadLabel = t('无');
  const inputPayload = formatToolPayload(detail.tool.input);
  const inputPreview = compactPayloadPreview(detail.tool.input, emptyPayloadLabel);
  const completeResult = detail.tool.rawResult ?? detail.tool.result;
  const hasActualResult = completeResult !== undefined && completeResult !== null && completeResult !== '';
  const resultPayload = formatToolPayload(completeResult);
  const resultPreview = compactPayloadPreview(completeResult, emptyPayloadLabel);

  useEffect(() => () => {
    if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current);
  }, []);

  const copyOutput = async () => {
    if (!resultPayload || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(resultPayload);
      setCopied(true);
      if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="ui-modal-overlay browser-chat-tool-dialog-overlay" onClick={onClose} role="presentation">
      <section aria-labelledby="browser-chat-tool-dialog-title" aria-modal="true" className="ui-modal ui-modal--wide browser-chat-tool-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
        <header className="ui-modal-header browser-chat-tool-dialog-header">
          <div className="ui-modal-heading">
            <h2 className="ui-modal-title" id="browser-chat-tool-dialog-title" title={detail.tool.name}>{toolName}</h2>
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
          <section className="browser-chat-tool-detail-summary" aria-label={t('工具调用摘要')}>
            <div>
              <span>{t('工具名')}</span>
              <strong title={detail.tool.name}>{toolName}</strong>
            </div>
            <div>
              <span>{t('输入摘要')}</span>
              <strong title={inputPreview}>{inputPreview}</strong>
            </div>
            <div>
              <span>{t('输出摘要')}</span>
              <strong title={resultPreview}>{resultPreview}</strong>
            </div>
          </section>

          <div className="browser-chat-tool-detail-layout">
            <aside className="browser-chat-tool-context-panel">
              {detail.tool.reason ? (
                <section className="browser-chat-tool-detail-section">
                  <h3>{t('调用理由')}</h3>
                  <p>{detail.tool.reason}</p>
                </section>
              ) : null}

              <section className="browser-chat-tool-detail-section">
                <h3>{t('输入参数')}</h3>
                <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" payload={inputPayload || emptyPayloadLabel} title={t('查看输入参数')} />
              </section>

              {detail.confirmationScreenshotUrl ? (
                <section className="browser-chat-tool-detail-section">
                  <h3>{t('用户确认时的页面截图')}</h3>
                  <a
                    className="browser-chat-tool-shot-card"
                    href={detail.confirmationScreenshotUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <img alt={t('用户确认时的页面截图')} src={detail.confirmationScreenshotUrl} />
                    <span>
                      <strong>{t('操作前确认截图')}</strong>
                      <code>{detail.confirmationScreenshotUrl}</code>
                    </span>
                  </a>
                </section>
              ) : null}

              {detail.tool.screenshots?.length ? (
                <section className="browser-chat-tool-detail-section">
                  <h3>{t('截图记录')}</h3>
                  <div className="browser-chat-tool-shot-grid">
                    {detail.tool.screenshots.map((shot, index) => {
                      const url = artifactApiUrl(shot.path);
                      return (
                        <a
                          className="browser-chat-tool-shot-card"
                          href={url || '#'}
                          key={`${shot.path}-${index}-preview`}
                          onClick={(event) => {
                            if (!url) event.preventDefault();
                          }}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {url ? <img alt={shot.title || t(screenshotKindLabel(shot.kind))} src={url} /> : null}
                          <span>
                            <strong>
                              {t(screenshotKindLabel(shot.kind))} · {shot.title || t('截图 {index}', { index: index + 1 })}
                            </strong>
                            <code>{shot.path}</code>
                          </span>
                        </a>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </aside>

            <section className="browser-chat-tool-output-panel">
              <header className="browser-chat-tool-output-header">
                <h3>{t('输出结果')}</h3>
                {hasActualResult ? (
                  <div className="browser-chat-tool-output-actions">
                    <span className="browser-chat-tool-output-format">JSON</span>
                    <span aria-hidden="true" className="browser-chat-tool-output-divider" />
                    <span>{t('自动换行')}</span>
                    <button
                      aria-checked={wrapOutput}
                      aria-label={t('切换输出自动换行')}
                      className="browser-chat-tool-wrap-toggle"
                      onClick={() => setWrapOutput((current) => !current)}
                      role="switch"
                      type="button"
                    >
                      <span />
                    </button>
                    <span aria-hidden="true" className="browser-chat-tool-output-divider" />
                    <button className="browser-chat-tool-copy-button" onClick={() => void copyOutput()} type="button">
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      {t(copied ? '已复制' : '复制')}
                    </button>
                  </div>
                ) : null}
              </header>
              {hasActualResult ? (
                <ToolOutputViewer payload={resultPayload || emptyPayloadLabel} wrap={wrapOutput} />
              ) : (
                <p className="browser-chat-tool-output-empty">{t('该卡片只有模型发出的工具请求，当前没有对应的真实执行结果。')}</p>
              )}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
