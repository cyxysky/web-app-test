'use client';

import { X } from 'lucide-react';
import { BrowserChatPayloadDetails } from '@/components/BrowserChatPayloadDetails';
import { formatToolPayload } from '@/components/browser-chat-format';
import { useI18n } from '@/i18n/I18nProvider';
import { domTreeFromToolCall, fullDomSnapshotFromToolCall } from '@/lib/ai-request-inspection';
import { artifactApiUrl } from '@/lib/artifacts';
import type { StepExecutionResult } from '@/server/ai/schemas/test-case.schema';

type BrowserChatToolCall = NonNullable<StepExecutionResult['tools']>[number];

export type BrowserChatToolDialogDetail = {
  stepIndex: number;
  step: StepExecutionResult;
  toolIndex: number;
  tool: BrowserChatToolCall;
};

function toolStatusLabel(tool: BrowserChatToolCall) {
  if (tool.ok === true) return '完成';
  if (tool.ok === false) return '失败';
  return '运行中';
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
  const domTree = domTreeFromToolCall(detail.tool, detail.step.aiRequest);
  const fullDomSnapshot = fullDomSnapshotFromToolCall(detail.tool);
  const status = toolStatusLabel(detail.tool);
  const inputPreview = compactPayloadPreview(detail.tool.input);
  const resultPreview = compactPayloadPreview(detail.tool.result);

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <section className="browser-chat-tool-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="工具调用详情">
        <header>
          <div>
            <h2 title={detail.tool.name}>{toolName}</h2>
            <p>
              步骤 {detail.stepIndex} · 工具调用 {detail.toolIndex + 1}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label={t('关闭')}>
            <X size={18} />
          </button>
        </header>

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
          <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" payload={formatToolPayload(detail.tool.result)} title="查看输出结果" />
        </section>

        {fullDomSnapshot ? (
          <section className="browser-chat-tool-detail-section is-full-dom">
            <h3>
              完整 DOM 快照
              {typeof detail.tool.debug?.fullDomSnapshotCharLength === 'number'
                ? `（${detail.tool.debug.fullDomSnapshotCharLength} 字符）`
                : ''}
            </h3>
            <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" payload={fullDomSnapshot} title="查看完整 DOM" />
          </section>
        ) : null}

        {domTree ? (
          <section className="browser-chat-tool-detail-section">
            <h3>
              模型上下文 DOM 树
              {detail.tool.debug?.domSnapshotTruncatedForModel ? '（已按上下文限制截断）' : ''}
            </h3>
            <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" payload={domTree} title="查看 DOM 内容" />
          </section>
        ) : null}

        {detail.tool.visualAfter ? (
          <section className="browser-chat-tool-detail-section">
            <h3>视觉截图参数</h3>
            <BrowserChatPayloadDetails className="browser-chat-tool-detail-payload" payload={formatToolPayload(detail.tool.visualAfter)} title="查看视觉截图参数" />
          </section>
        ) : null}

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
                    rel="noreferrer"
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
      </section>
    </div>
  );
}
