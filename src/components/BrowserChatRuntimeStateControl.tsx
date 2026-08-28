'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type BrowserChatRuntimeStateEntry = {
  key: string;
  value: unknown;
  revision: number;
  updatedAt: string;
  expiresAt?: string;
};

type BrowserChatRuntimeStateResult = {
  items: BrowserChatRuntimeStateEntry[];
  count: number;
  truncated: boolean;
};

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
  const { t } = useI18n();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [snapshot, setSnapshot] = useState<{ items: BrowserChatRuntimeStateEntry[]; sessionId: string }>({
    items: [],
    sessionId: '',
  });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const items = useMemo(
    () => snapshot.sessionId === sessionId ? snapshot.items : [],
    [sessionId, snapshot],
  );
  const panelId = `browser-chat-runtime-state-${sessionId}`;
  const allValuesText = useMemo(
    () => JSON.stringify(Object.fromEntries(items.map((item) => [item.key, item.value])), null, 2),
    [items],
  );

  useEffect(() => {
    setOpen(false);
    setError('');
    setCopiedKey('');
  }, [sessionId]);

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
        const data = await readApiJson<BrowserChatRuntimeStateResult>(response, t('读取模型变量失败'));
        if (disposed) return;
        setSnapshot({ items: data.items, sessionId });
        setError('');
        if (!data.items.length) setOpen(false);
      } catch (loadError) {
        if (!disposed && open) {
          setError(loadError instanceof Error ? loadError.message : t('读取模型变量失败'));
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
      setError(t('复制变量失败'));
    }
  };

  return (
    <div className="browser-chat-runtime-state-anchor" ref={anchorRef}>
      {children}
      {items.length ? (
        <>
          <button
            aria-controls={panelId}
            aria-expanded={open}
            aria-label={t('查看模型变量，共 {count} 个', { count: items.length })}
            className={`browser-chat-runtime-state-bubble${open ? ' is-open' : ''}`}
            onClick={() => setOpen((current) => !current)}
            title={t('模型存储了 {count} 个变量', { count: items.length })}
            type="button"
          >
            <svg aria-hidden="true" className="browser-chat-runtime-state-bubble-icon" viewBox="0 0 24 24">
              <path d="M5.5 4.75h13A1.75 1.75 0 0 1 20.25 6.5v9a1.75 1.75 0 0 1-1.75 1.75h-3.7L12 19.65l-2.8-2.4H5.5a1.75 1.75 0 0 1-1.75-1.75v-9A1.75 1.75 0 0 1 5.5 4.75Z" />
              <path d="M8 10.4h8" />
            </svg>
          </button>
          {open ? (
            <section aria-label={t('模型变量')} className="browser-chat-runtime-state-card" id={panelId}>
              <header>
                <div className="browser-chat-runtime-state-card-heading">
                  <div className="browser-chat-runtime-state-card-title">
                    <span aria-hidden="true" className="browser-chat-runtime-state-card-marker" />
                    <strong>{t('模型存储的变量')}</strong>
                  </div>
                  <span>{t('当前对话共 {count} 个', { count: items.length })}</span>
                </div>
                <div className="browser-chat-runtime-state-card-actions">
                  <button
                    aria-label={copiedKey === '__all__' ? t('全部变量已复制') : t('复制全部变量')}
                    onClick={() => void copyValue('__all__', allValuesText)}
                    title={copiedKey === '__all__' ? t('已复制') : t('复制全部变量')}
                    type="button"
                  >
                    {copiedKey === '__all__' ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
                  </button>
                  <button aria-label={t('关闭模型变量卡片')} onClick={() => setOpen(false)} title={t('关闭')} type="button">
                    <X aria-hidden="true" size={16} />
                  </button>
                </div>
              </header>
              {loading ? <div className="browser-chat-runtime-state-loading"><Loader2 className="spin" size={14} />{t('正在刷新变量')}</div> : null}
              {error ? <p className="browser-chat-runtime-state-error" role="alert">{error}</p> : null}
              <div className="browser-chat-runtime-state-list">
                {items.map((item) => {
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
                })}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
