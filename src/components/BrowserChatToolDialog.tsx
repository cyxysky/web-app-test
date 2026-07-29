'use client';

import { X } from 'lucide-react';
import { BrowserChatPayloadDetails } from '@/components/BrowserChatPayloadDetails';
import { formatToolPayload } from '@/components/browser-chat-format';
import { useI18n } from '@/i18n/I18nProvider';
import { artifactApiUrl } from '@/lib/artifacts';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';

type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

export type BrowserChatToolDialogDetail = {
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

function compactPayloadPreview(value: unknown, max = 180) {
  const text = formatToolPayload(value).replace(/\s+/g, ' ').trim();
  if (!text || text === 'None') return '无';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
  const toolName = toolLabel(detail.tool.name);
  const status = toolStatusLabel(detail.tool, detail.step);
  const inputPreview = compactPayloadPreview(detail.tool.input);
  const completeResult = detail.tool.rawResult ?? detail.tool.result;
  const hasActualResult = completeResult !== undefined && completeResult !== null && completeResult !== '';
  const resultPreview = compactPayloadPreview(completeResult);

  return (
    <div className="ui-modal-overlay" onClick={onClose} role="presentation">
      <section className="ui-modal ui-modal--wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="工具调用详情">
        <header className="ui-modal-header">
          <div className="ui-modal-heading">
            <h2 className="ui-modal-title" title={detail.tool.name}>{toolName}</h2>
            <p className="ui-modal-subtitle">
              步骤 {detail.stepIndex} · 工具调用 {detail.toolIndex + 1}
            </p>
          </div>
          <button className="ui-icon-button ui-modal-close" onClick={onClose} type="button" aria-label={t('关闭')}>
            <X size={18} />
          </button>
        </header>

        <div className="ui-modal-body browser-chat-tool-modal-body">
        <section className="browser-chat-tool-detail-summary" aria-label="工具调用摘要">
          <div>
            <span>状态</span>
            <strong>{status}</strong>
          </div>
          <div>
            <span>工具名</span>
            <strong title={detail.tool.name}>{toolName}</strong>
          </div>
          <div>
            <span>输入摘要</span>
            <strong title={inputPreview}>{inputPreview}</strong>
          </div>
          <div>
            <span>输出摘要</span>
            <strong title={resultPreview}>{resultPreview}</strong>
          </div>
        </section>

        {detail.tool.reason ? (
          <section className="browser-chat-tool-detail-section">
            <h3>调用理由</h3>
            <p>{detail.tool.reason}</p>
          </section>
        ) : null}

        <section className="browser-chat-tool-detail-section">
          <h3>输入参数</h3>
          <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" payload={formatToolPayload(detail.tool.input)} title="查看输入参数" />
        </section>

        <section className="browser-chat-tool-detail-section">
          <h3>输出结果</h3>
          {hasActualResult ? (
            <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" defaultOpen payload={formatToolPayload(completeResult)} title="完整输出结果" />
          ) : (
            <p>该卡片只有模型发出的工具请求，当前没有对应的真实执行结果。</p>
          )}
        </section>

        {detail.tool.screenshots?.length ? (
          <section className="browser-chat-tool-detail-section">
            <h3>截图记录</h3>
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
                    {url ? <img alt={shot.title || screenshotKindLabel(shot.kind)} src={url} /> : null}
                    <span>
                      <strong>
                        {screenshotKindLabel(shot.kind)} · {shot.title || `截图 ${index + 1}`}
                      </strong>
                      <code>{shot.path}</code>
                    </span>
                  </a>
                );
              })}
            </div>
            <ol className="browser-chat-tool-shot-list">
              {detail.tool.screenshots.map((shot, index) => (
                <li key={`${shot.path}-${index}`}>
                  <strong>{shot.title || shot.kind || `截图 ${index + 1}`}</strong>
                  <code>{shot.path}</code>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        </div>
      </section>
    </div>
  );
}
