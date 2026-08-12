'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Check, Loader2, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WebPilotOnboardingReadiness, WebPilotOnboardingState, WebPilotOnboardingStep } from '@/lib/onboarding';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type OnboardingPayload = {
  readiness: WebPilotOnboardingReadiness;
  state: WebPilotOnboardingState;
};

export function BrowserChatOnboarding({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (content: string) => Promise<boolean>;
}) {
  const searchParams = useSearchParams();
  const forceTutorial = searchParams.get('onboarding') === '1';
  const [payload, setPayload] = useState<OnboardingPayload>();
  const [showTutorial, setShowTutorial] = useState(false);
  const [starting, setStarting] = useState(false);
  const onboardingUrl = withWebPilotBasePath('/api/onboarding');

  const load = useCallback(async () => {
    const data = await fetch(onboardingUrl, { cache: 'no-store' })
      .then((response) => readApiJson<OnboardingPayload>(response, '加载新手教程失败'));
    setPayload(data);
    setShowTutorial(forceTutorial || !['completed', 'dismissed'].includes(data.state.status));
  }, [forceTutorial, onboardingUrl]);

  useEffect(() => {
    void load().catch(() => setPayload(undefined));
  }, [load]);

  const update = useCallback(async (action: 'complete_step' | 'reset' | 'skip' | 'start', step?: WebPilotOnboardingStep) => {
    const data = await fetch(onboardingUrl, {
      body: JSON.stringify({ action, step }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    }).then((response) => readApiJson<{ state: WebPilotOnboardingState }>(response, '更新新手教程失败'));
    setPayload((current) => current ? { ...current, state: data.state } : current);
    return data.state;
  }, [onboardingUrl]);

  const readinessItems = useMemo(() => payload ? [
    ['模型', payload.readiness.model],
    ['浏览器', payload.readiness.browser],
    ['图片输入', payload.readiness.vision],
    ['Office', payload.readiness.libreOffice],
  ] as const : [], [payload]);

  async function startTutorial() {
    if (starting || busy) return;
    setStarting(true);
    try {
      await update('start');
      const target = `${window.location.origin}${withWebPilotBasePath('/tutorial-sandbox')}`;
      const sent = await onSubmit(`打开 ${target}。在演练表单中把姓名填写为“测试用户”，部门选择“研发部”，不要点击提交；然后读取页面状态，确认姓名和部门已经填写且表单仍未提交。`);
      if (sent) await update('complete_step', 'browser_task');
    } finally {
      setStarting(false);
    }
  }

  if (!payload) {
    return <div className="browser-chat-empty-start is-loading"><Loader2 className="spin" size={20} /><span>正在准备工作区</span></div>;
  }

  if (!showTutorial) {
    return (
      <section className="browser-chat-empty-start" aria-label="开始新对话">
        <div className="browser-chat-empty-heading">
          <span>WebPilot</span>
          <h1>今天想让浏览器帮你做什么？</h1>
          <p>描述目标即可。涉及提交、删除或其他外部影响的操作仍会按安全模式确认。</p>
        </div>
        <button className="browser-chat-tutorial-link" onClick={() => setShowTutorial(true)} type="button">查看 3 分钟新手教程</button>
      </section>
    );
  }

  return (
    <section className="browser-chat-onboarding" aria-label="WebPilot 新手教程">
      <div className="browser-chat-onboarding-copy">
        <span className="browser-chat-onboarding-kicker">3 分钟上手</span>
        <h1>先完成一次安全的浏览器任务</h1>
        <p>演练只操作 WebPilot 内置页面，不会修改真实业务数据。你会看到页面读取、表单填写和结果验证的完整过程。</p>
      </div>

      <div className="browser-chat-readiness-grid" aria-label="环境检查">
        {readinessItems.map(([label, item]) => (
          <div className={item.ready ? 'is-ready' : 'is-warning'} key={label} title={item.detail}>
            <span>{item.ready ? <Check size={14} /> : '!'}</span>
            <div><strong>{label}</strong><small>{item.detail}</small></div>
          </div>
        ))}
      </div>

      <div className="browser-chat-onboarding-actions">
        <button className="ui-button primary" disabled={busy || starting || !payload.readiness.model.ready || !payload.readiness.browser.ready} onClick={() => void startTutorial()} type="button">
          {starting ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />}
          开始演练
        </button>
        {!payload.readiness.model.ready ? (
          <Link className="ui-button secondary" href="/settings"><Settings size={16} />配置模型</Link>
        ) : null}
        <button className="browser-chat-tutorial-skip" onClick={() => void update('skip').then(() => setShowTutorial(false))} type="button">暂时跳过</button>
      </div>
    </section>
  );
}
