'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Loader2, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { artifactApiUrl } from '@/lib/artifacts';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type BrowserChatRuntimeStateEntry = {
  key: string;
  value: unknown;
  revision: number;
  updatedAt: string;
  expiresAt?: string;
};

type BrowserChatDefectEvidence = {
  fileName: string;
  path: string;
};

type BrowserChatDefectReport = {
  id: string;
  sessionId: string;
  title: string;
  problemDescription: string;
  whyItIsAProblem: string;
  reasons: string[];
  reproductionSteps: string[];
  screenshots: BrowserChatDefectEvidence[];
  severity: 'high' | 'medium' | 'low';
  createdAt: string;
};

type BrowserChatRuntimeStateResult = {
  items: BrowserChatRuntimeStateEntry[];
  count: number;
  truncated: boolean;
  defects: BrowserChatDefectReport[];
};

type RuntimeRecordTab = 'variables' | 'defects';

function runtimeStateValueText(value: unknown) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? 'null';
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Copy failed');
  }
}

export function BrowserChatRuntimeStateControl({
  active,
  children,
  sessionId,
}: {
  active: boolean;
  children: ReactNode;
  sessionId: string;
}) {
  const { language, t } = useI18n();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [snapshot, setSnapshot] = useState<{
    defects: BrowserChatDefectReport[];
    items: BrowserChatRuntimeStateEntry[];
    sessionId: string;
  }>({ defects: [], items: [], sessionId: '' });
  const [activeTab, setActiveTab] = useState<RuntimeRecordTab>('variables');
  const [expandedDefectId, setExpandedDefectId] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const items = useMemo(
    () => snapshot.sessionId === sessionId ? snapshot.items : [],
    [sessionId, snapshot],
  );
  const defects = useMemo(
    () => snapshot.sessionId === sessionId ? snapshot.defects : [],
    [sessionId, snapshot],
  );
  const recordCount = items.length + defects.length;
  const panelId = `browser-chat-runtime-state-${sessionId}`;
  const variablesPanelId = `${panelId}-variables-panel`;
  const defectsPanelId = `${panelId}-defects-panel`;
  const copyPayload = useMemo(() => activeTab === 'variables'
    ? JSON.stringify(Object.fromEntries(items.map((item) => [item.key, item.value])), null, 2)
    : JSON.stringify(defects, null, 2), [activeTab, defects, items]);

  useEffect(() => {
    setOpen(false);
    setActiveTab('variables');
    setExpandedDefectId('');
    setError('');
    setCopiedKey('');
  }, [sessionId]);

  useEffect(() => {
    if (!defects.length) {
      setExpandedDefectId('');
      return;
    }
    setExpandedDefectId((current) => defects.some((defect) => defect.id === current) ? current : defects[0].id);
  }, [defects]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let disposed = false;
    let requestActive = false;
    const refresh = async (showLoading = false) => {
      if (requestActive) return;
      requestActive = true;
      if (showLoading) setLoading(true);
      try {
        const response = await fetch(
          withWebPilotBasePath(`/api/browser-chat/${encodeURIComponent(sessionId)}/state`),
          { cache: 'no-store' },
        );
        const data = await readApiJson<BrowserChatRuntimeStateResult>(response, t('读取模型运行记录失败'));
        if (disposed) return;
        setSnapshot({ defects: data.defects || [], items: data.items || [], sessionId });
        setError('');
        if (!data.items?.length && !data.defects?.length) setOpen(false);
      } catch (loadError) {
        if (!disposed && open) {
          setError(loadError instanceof Error ? loadError.message : t('读取模型运行记录失败'));
        }
      } finally {
        requestActive = false;
        if (!disposed && showLoading) setLoading(false);
      }
    };
    void refresh(open);
    const refreshInterval = active ? 1_500 : open ? 5_000 : 0;
    const timer = refreshInterval ? window.setInterval(() => void refresh(false), refreshInterval) : undefined;
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [active, open, sessionId, t]);

  useEffect(() => {
    if (!open) return undefined;
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOnPointerDown, true);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointerDown, true);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  const copyValue = async (key: string, value: string) => {
    try {
      await copyText(value);
      setCopiedKey(key);
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = setTimeout(() => setCopiedKey(''), 1_600);
    } catch {
      setError(t('复制运行记录失败'));
    }
  };

  const togglePanel = () => {
    setOpen((current) => {
      if (!current) setActiveTab(defects.length ? 'defects' : 'variables');
      return !current;
    });
  };

  const defectAgeText = (createdAt: string) => {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 60_000) return t('刚刚');
    if (ageMs < 3_600_000) return t('{count} 分钟前', { count: Math.max(1, Math.floor(ageMs / 60_000)) });
    if (ageMs < 86_400_000) return t('{count} 小时前', { count: Math.max(1, Math.floor(ageMs / 3_600_000)) });
    return new Date(createdAt).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
    });
  };

  const severityText = (severity: BrowserChatDefectReport['severity']) => ({
    high: t('高'),
    medium: t('中'),
    low: t('低'),
  })[severity];

  return (
    <div className="browser-chat-runtime-state-anchor" ref={anchorRef}>
      {children}
      {recordCount ? (
        <>
          <button
            aria-controls={panelId}
            aria-expanded={open}
            aria-label={t('查看模型运行记录，共 {count} 项', { count: recordCount })}
            className={`browser-chat-runtime-state-bubble${open ? ' is-open' : ''}`}
            onClick={togglePanel}
            title={t('模型运行记录：{variables} 个变量，{defects} 个缺陷', {
              variables: items.length,
              defects: defects.length,
            })}
            type="button"
          >
            <svg aria-hidden="true" className="browser-chat-runtime-state-bubble-icon" viewBox="0 0 24 24">
              <path d="M5.5 4.75h13A1.75 1.75 0 0 1 20.25 6.5v9a1.75 1.75 0 0 1-1.75 1.75h-3.7L12 19.65l-2.8-2.4H5.5a1.75 1.75 0 0 1-1.75-1.75v-9A1.75 1.75 0 0 1 5.5 4.75Z" />
              <path d="M8 10.4h8" />
            </svg>
          </button>
          {open ? (
            <section aria-label={t('模型运行记录')} className="browser-chat-runtime-state-card" id={panelId}>
              <header>
                <div className="browser-chat-runtime-state-card-heading">
                  <div className="browser-chat-runtime-state-card-title">
                    <span aria-hidden="true" className="browser-chat-runtime-state-card-marker" />
                    <strong>{t('模型运行记录')}</strong>
                  </div>
                  <span>{t('当前对话')}</span>
                </div>
                <div className="browser-chat-runtime-state-card-actions">
                  <button
                    aria-label={copiedKey === '__all__'
                      ? t('当前记录已复制')
                      : activeTab === 'variables' ? t('复制全部变量') : t('复制全部缺陷')}
                    onClick={() => void copyValue('__all__', copyPayload)}
                    title={copiedKey === '__all__' ? t('已复制') : t('复制当前记录')}
                    type="button"
                  >
                    {copiedKey === '__all__' ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
                  </button>
                  <button aria-label={t('关闭模型运行记录')} onClick={() => setOpen(false)} title={t('关闭')} type="button">
                    <X aria-hidden="true" size={19} />
                  </button>
                </div>
              </header>

              <div aria-label={t('模型运行记录分类')} className="browser-chat-runtime-state-tabs" role="tablist">
                <button
                  aria-controls={variablesPanelId}
                  aria-selected={activeTab === 'variables'}
                  className={activeTab === 'variables' ? 'is-active' : ''}
                  id={`${panelId}-variables-tab`}
                  onClick={() => setActiveTab('variables')}
                  role="tab"
                  type="button"
                >
                  {t('变量')} <span>{items.length}</span>
                </button>
                <button
                  aria-controls={defectsPanelId}
                  aria-selected={activeTab === 'defects'}
                  className={activeTab === 'defects' ? 'is-active' : ''}
                  id={`${panelId}-defects-tab`}
                  onClick={() => setActiveTab('defects')}
                  role="tab"
                  type="button"
                >
                  {t('缺陷')} <span>{defects.length}</span>
                </button>
              </div>

              {loading ? <div className="browser-chat-runtime-state-loading"><Loader2 className="spin" size={14} />{t('正在刷新运行记录')}</div> : null}
              {error ? <p className="browser-chat-runtime-state-error" role="alert">{error}</p> : null}

              {activeTab === 'variables' ? (
                <div
                  aria-labelledby={`${panelId}-variables-tab`}
                  className="browser-chat-runtime-state-list"
                  id={variablesPanelId}
                  role="tabpanel"
                >
                  {items.length ? items.map((item) => {
                    const valueText = runtimeStateValueText(item.value);
                    const copied = copiedKey === item.key;
                    return (
                      <article className="browser-chat-runtime-state-item" key={item.key}>
                        <div className="browser-chat-runtime-state-item-heading">
                          <code title={item.key}>{item.key}</code>
                          <button
                            aria-label={copied ? t('变量值已复制') : t('复制变量 {name} 的值', { name: item.key })}
                            className={copied ? 'is-copied' : ''}
                            onClick={() => void copyValue(item.key, valueText)}
                            title={copied ? t('已复制') : t('复制变量值')}
                            type="button"
                          >
                            {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                          </button>
                        </div>
                        <pre>{valueText}</pre>
                      </article>
                    );
                  }) : <div className="browser-chat-runtime-state-empty">{t('当前对话暂无模型变量')}</div>}
                </div>
              ) : (
                <div
                  aria-labelledby={`${panelId}-defects-tab`}
                  className="browser-chat-defect-panel"
                  id={defectsPanelId}
                  role="tabpanel"
                >
                  <div className="browser-chat-defect-panel-heading">
                    <strong>{t('模型报告的缺陷')}</strong>
                    <span>{t('共 {count} 项', { count: defects.length })}</span>
                  </div>
                  {defects.length ? (
                    <div className="browser-chat-defect-list">
                      {defects.map((defect) => {
                        const expanded = expandedDefectId === defect.id;
                        return (
                          <article className={`browser-chat-defect-item${expanded ? ' is-expanded' : ''}`} key={defect.id}>
                            <button
                              aria-expanded={expanded}
                              className="browser-chat-defect-summary"
                              onClick={() => setExpandedDefectId(expanded ? '' : defect.id)}
                              type="button"
                            >
                              <span className="browser-chat-defect-title">{defect.title}</span>
                              <span className={`browser-chat-defect-severity is-${defect.severity}`}>{severityText(defect.severity)}</span>
                              {expanded ? <span className="browser-chat-defect-age">{defectAgeText(defect.createdAt)}</span> : null}
                              {expanded ? <ChevronUp aria-hidden="true" size={17} /> : <ChevronDown aria-hidden="true" size={17} />}
                            </button>
                            {expanded ? (
                              <div className="browser-chat-defect-detail">
                                <div className="browser-chat-defect-detail-columns">
                                  <div className="browser-chat-defect-explanation">
                                    <section>
                                      <h3>{t('问题描述')}</h3>
                                      <p>{defect.problemDescription}</p>
                                    </section>
                                    <section>
                                      <h3>{t('为什么这是问题')}</h3>
                                      <p>{defect.whyItIsAProblem}</p>
                                    </section>
                                    <section>
                                      <h3>{t('判定理由')}</h3>
                                      <ul>
                                        {defect.reasons.map((reason, index) => <li key={`${defect.id}-reason-${index}`}>{reason}</li>)}
                                      </ul>
                                    </section>
                                  </div>
                                  <section className="browser-chat-defect-steps">
                                    <h3>{t('复现步骤')}</h3>
                                    <ol>
                                      {defect.reproductionSteps.map((step, index) => <li key={`${defect.id}-step-${index}`}>{step}</li>)}
                                    </ol>
                                  </section>
                                </div>
                                <section className="browser-chat-defect-evidence">
                                  <h3>{t('截图证明')}</h3>
                                  <div className="browser-chat-defect-evidence-grid">
                                    {defect.screenshots.map((screenshot) => {
                                      const url = artifactApiUrl(screenshot.path);
                                      return url ? (
                                        <a href={url} key={screenshot.path} rel="noreferrer" target="_blank" title={t('查看截图 {name}', { name: screenshot.fileName })}>
                                          <img alt={t('缺陷截图证明：{name}', { name: screenshot.fileName })} loading="lazy" src={url} />
                                          <span>{screenshot.fileName}</span>
                                        </a>
                                      ) : null;
                                    })}
                                  </div>
                                </section>
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  ) : <div className="browser-chat-runtime-state-empty">{t('模型尚未报告缺陷')}</div>}
                </div>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
