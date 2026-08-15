'use client';

import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, CircleHelp, FileText, Globe2, Loader2, RotateCcw, Settings, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import {
  WEBPILOT_ONBOARDING_RESTART_EVENT,
  type WebPilotOnboardingReadiness,
  type WebPilotOnboardingState,
} from '@/lib/onboarding';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type HelpPayload = { readiness: WebPilotOnboardingReadiness; state: WebPilotOnboardingState };

export function WebPilotHelpCenter({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [payload, setPayload] = useState<HelpPayload>();
  const [resetting, setResetting] = useState(false);
  const endpoint = withWebPilotBasePath('/api/onboarding');

  const load = useCallback(async () => {
    setPayload(await fetch(endpoint, { cache: 'no-store' })
      .then((response) => readApiJson<HelpPayload>(response, t('加载帮助中心失败'))));
  }, [endpoint, t]);

  useEffect(() => setPortalReady(true), []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  async function restartTutorial() {
    setResetting(true);
    try {
      await fetch(endpoint, {
        body: JSON.stringify({ action: 'reset' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }).then((response) => readApiJson(response, t('重置教程失败')));
      setOpen(false);
      window.dispatchEvent(new Event(WEBPILOT_ONBOARDING_RESTART_EVENT));
      router.replace('/browser-chat?onboarding=1');
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <button
        aria-controls="webpilot-help-drawer"
        aria-expanded={open}
        aria-label={t('帮助与教程')}
        className="workspace-help-button"
        onClick={() => setOpen(true)}
        style={collapsed ? { alignSelf: 'center', flex: '0 0 36px', height: 36, minHeight: 36, padding: 0, width: 36 } : undefined}
        title={t('帮助与教程')}
        type="button"
      >
        <CircleHelp aria-hidden="true" size={17} />
        <span>{t('帮助与教程')}</span>
      </button>
      {portalReady ? createPortal(
        <div
          aria-hidden={!open}
          className={`webpilot-help-backdrop${open ? ' is-open' : ''}`}
          inert={!open}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <aside aria-label={t('WebPilot 帮助中心')} aria-modal="true" className="webpilot-help-drawer" id="webpilot-help-drawer" role="dialog">
            <header>
              <div><span>WebPilot</span><h2>{t('帮助与教程')}</h2></div>
              <button aria-label={t('关闭帮助中心')} className="ui-icon-button" onClick={() => setOpen(false)} type="button"><X size={18} /></button>
            </header>

            <div className="webpilot-help-content">
              <section>
                <h3>{t('快速开始')}</h3>
                <ol className="webpilot-help-steps">
                  <li><Globe2 size={17} /><div><strong>{t('描述浏览器目标')}</strong><p>{t('说明要访问哪里、查什么或填写什么；提交和删除操作会按安全模式确认。')}</p></div></li>
                  <li><FileText size={17} /><div><strong>{t('按需引用文件')}</strong><p>{t('上传附件后说明目标。模型先看到元数据，只在任务需要时读取正文和页面图像。')}</p></div></li>
                  <li><Workflow size={17} /><div><strong>{t('复用成功过程')}</strong><p>{t('一次任务成功后，可从回答下方生成自动化用例或 Skill。')}</p></div></li>
                </ol>
              </section>

              <section>
                <h3>{t('当前环境')}</h3>
                {payload ? (
                  <div className="webpilot-help-readiness">
                    {Object.entries(payload.readiness).map(([key, item]) => (
                      <div key={key}><span className={item.ready ? 'ready' : 'warning'}>{item.ready ? <Check size={13} /> : '!'}</span><p>{t(item.detail)}</p></div>
                    ))}
                  </div>
                ) : <div className="webpilot-help-loading"><Loader2 className="spin" size={16} />{t('正在检查')}</div>}
              </section>

              <section>
                <h3>{t('常见问题')}</h3>
                <details><summary>{t('为什么有些操作需要确认？')}</summary><p>{t('严格安全模式会在提交、删除、上传和其他会产生外部影响的操作前请求确认。')}</p></details>
                <details><summary>{t('文件为什么没有自动全文读取？')}</summary><p>{t('附件默认只提供名称、类型和大小，避免把无关大文件全部放进模型上下文。需要分析时模型会调用 readFile 分段读取。')}</p></details>
                <details><summary>{t('浏览器登录状态在哪里？')}</summary><p>{t('登录状态保存在当前用户的受控浏览器配置中；每个对话只接管属于自己标签组的页面。')}</p></details>
              </section>
            </div>

            <footer>
              <button className="ui-button secondary" disabled={resetting} onClick={() => void restartTutorial()} type="button">
                {resetting ? <Loader2 className="spin" size={15} /> : <RotateCcw size={15} />}{t('重新开始教程')}
              </button>
              <Link className="ui-button secondary" href="/settings" onClick={() => setOpen(false)}><Settings size={15} />{t('打开设置')}</Link>
            </footer>
          </aside>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
