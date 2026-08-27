'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Brain,
  Check,
  FileCheck2,
  KeyRound,
  Loader2,
  Settings,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { WebPilotOnboardingReadiness, WebPilotOnboardingState, WebPilotOnboardingStep } from '@/lib/onboarding';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { TextAnimate } from '@/components/ui/text-animate';

type OnboardingPayload = {
  readiness: WebPilotOnboardingReadiness;
  state: WebPilotOnboardingState;
};

type OnboardingGuideStep = {
  description: string;
  icon: LucideIcon;
  id: WebPilotOnboardingStep;
  label: string;
  title: string;
};

type OnboardingManagementTab = 'accounts' | 'memory' | 'skills';
type OnboardingSafetyMode = 'full' | 'strict';

export function BrowserChatOnboarding({
  busy,
  modelLabel,
  onOpenManagement,
  onOpenModelSelector,
  onSafetyModeChange,
  onSubmit,
  safetyMode,
}: {
  busy: boolean;
  modelLabel: string;
  onOpenManagement: (tab: OnboardingManagementTab) => void;
  onOpenModelSelector: () => void;
  onSafetyModeChange: (mode: OnboardingSafetyMode) => void;
  onSubmit: (content: string) => Promise<boolean>;
  safetyMode: OnboardingSafetyMode;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const forceTutorial = searchParams.get('onboarding') === '1';
  const [payload, setPayload] = useState<OnboardingPayload>();
  const [showTutorial, setShowTutorial] = useState(false);
  const [activeStepId, setActiveStepId] = useState<WebPilotOnboardingStep>('welcome');
  const [advancing, setAdvancing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [tutorialError, setTutorialError] = useState('');
  const onboardingUrl = withWebPilotBasePath('/api/onboarding');

  const guideSteps = useMemo<OnboardingGuideStep[]>(() => [
    {
      description: t('先认识一次完整任务从描述目标到交付结果的基本流程。'),
      icon: Sparkles,
      id: 'welcome',
      label: t('开始'),
      title: t('先学会描述一个可验证的任务'),
    },
    {
      description: t('按站点保存登录资料，让浏览器在需要时安全填写。'),
      icon: KeyRound,
      id: 'accounts',
      label: t('账号'),
      title: t('账号用于登录，不会把密码交给模型'),
    },
    {
      description: t('把稳定的方法交给 Skill，把可重复执行的流程交给自动化。'),
      icon: Workflow,
      id: 'skills',
      label: 'Skill',
      title: t('Skill 和自动化解决不同的复用问题'),
    },
    {
      description: t('保存长期偏好和业务约定，让后续对话少重复说明。'),
      icon: Brain,
      id: 'memory',
      label: t('记忆'),
      title: t('记忆是可查看、可编辑的长期上下文'),
    },
    {
      description: t('根据任务风险选择需要确认还是连续执行。'),
      icon: ShieldCheck,
      id: 'permissions',
      label: t('权限'),
      title: t('严谨模式和完全模式该怎么选'),
    },
    {
      description: t('根据任务是否需要图片、长上下文和强工具调用能力选择模型。'),
      icon: Bot,
      id: 'model',
      label: t('模型'),
      title: t('模型决定理解和执行能力的上限'),
    },
    {
      description: t('确认模型、浏览器、图片输入和 Office 能力是否可用。'),
      icon: Settings,
      id: 'readiness',
      label: t('环境'),
      title: t('开始前先看懂环境状态'),
    },
    {
      description: t('在内置页面完成一次不会提交数据的浏览器任务。'),
      icon: FileCheck2,
      id: 'browser_task',
      label: t('演练'),
      title: t('现在完成第一次安全演练'),
    },
  ], [t]);

  const load = useCallback(async () => {
    const data = await fetch(onboardingUrl, { cache: 'no-store' })
      .then((response) => readApiJson<OnboardingPayload>(response, t('加载新手教程失败')));
    setPayload(data);
    setShowTutorial(forceTutorial || !['completed', 'dismissed'].includes(data.state.status));
  }, [forceTutorial, onboardingUrl, t]);

  useEffect(() => {
    void load().catch(() => setPayload(undefined));
  }, [load]);

  useEffect(() => {
    if (!payload || !showTutorial) return;
    const firstIncomplete = guideSteps.find((step) => !payload.state.completedSteps.includes(step.id));
    setActiveStepId(firstIncomplete?.id || guideSteps[0]!.id);
  }, [guideSteps, payload, showTutorial]);

  const update = useCallback(async (action: 'complete_step' | 'reset' | 'skip' | 'start', step?: WebPilotOnboardingStep) => {
    const data = await fetch(onboardingUrl, {
      body: JSON.stringify({ action, step }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    }).then((response) => readApiJson<{ state: WebPilotOnboardingState }>(response, t('更新新手教程失败')));
    setPayload((current) => current ? { ...current, state: data.state } : current);
    return data.state;
  }, [onboardingUrl, t]);

  const readinessItems = useMemo(() => payload ? [
    [t('模型'), payload.readiness.model],
    [t('浏览器'), payload.readiness.browser],
    [t('图片输入'), payload.readiness.vision],
    ['Office', payload.readiness.libreOffice],
  ] as const : [], [payload, t]);

  const activeStepIndex = Math.max(0, guideSteps.findIndex((step) => step.id === activeStepId));
  const activeStep = guideSteps[activeStepIndex]!;
  const ActiveStepIcon = activeStep.icon;

  function clearTutorialQuery() {
    const nextSearch = new URLSearchParams(searchParams.toString());
    nextSearch.delete('onboarding');
    const query = nextSearch.toString();
    router.replace(query ? `/browser-chat?${query}` : '/browser-chat');
  }

  async function completeCurrentStep() {
    if (!payload || advancing || activeStepIndex >= guideSteps.length - 1) return;
    if (payload.state.completedSteps.includes(activeStep.id)) {
      setActiveStepId(guideSteps[activeStepIndex + 1]!.id);
      return;
    }
    setAdvancing(true);
    setTutorialError('');
    try {
      if (payload.state.status === 'not_started') await update('start');
      await update('complete_step', activeStep.id);
      setActiveStepId(guideSteps[activeStepIndex + 1]!.id);
    } catch (error) {
      setTutorialError(error instanceof Error ? error.message : t('更新新手教程失败'));
    } finally {
      setAdvancing(false);
    }
  }

  async function skipTutorial() {
    if (advancing || starting) return;
    setAdvancing(true);
    setTutorialError('');
    try {
      await update('skip');
      setShowTutorial(false);
      clearTutorialQuery();
    } catch (error) {
      setTutorialError(error instanceof Error ? error.message : t('更新新手教程失败'));
    } finally {
      setAdvancing(false);
    }
  }

  async function startTutorial() {
    if (!payload || starting || busy) return;
    setStarting(true);
    setTutorialError('');
    try {
      if (payload.state.status === 'not_started') await update('start');
      const target = `${window.location.origin}${withWebPilotBasePath('/tutorial-sandbox')}`;
      const sent = await onSubmit(t('打开 {target}。在演练表单中把姓名填写为“测试用户”，部门选择“研发部”，不要点击提交；然后读取页面状态，确认姓名和部门已经填写且表单仍未提交。', { target }));
      if (sent) {
        await update('complete_step', 'browser_task');
        clearTutorialQuery();
      }
    } catch (error) {
      setTutorialError(error instanceof Error ? error.message : t('更新新手教程失败'));
    } finally {
      setStarting(false);
    }
  }

  function renderStepContent() {
    if (activeStep.id === 'welcome') {
      return (
        <>
          <div className="browser-chat-onboarding-principles">
            <div><strong>{t('目标')}</strong><span>{t('明确要浏览器完成什么')}</span></div>
            <div><strong>{t('范围')}</strong><span>{t('说明站点、页面、文件或时间范围')}</span></div>
            <div><strong>{t('完成标准')}</strong><span>{t('告诉模型怎样才算完成')}</span></div>
          </div>
          <div className="browser-chat-onboarding-example">
            <span>{t('示例')}</span>
            <p>{t('打开项目列表，筛选本月延期的项目，整理项目名和负责人到 Excel；只生成文件，不要修改页面数据。')}</p>
          </div>
          <p className="browser-chat-onboarding-note">{t('可以同时附加文件或页面引用；任务执行中仍可继续输入，后续消息会进入等待队列。')}</p>
        </>
      );
    }

    if (activeStep.id === 'accounts') {
      return (
        <>
          <ul className="browser-chat-onboarding-facts">
            <li><Check size={15} /><span>{t('账号按域名保存，只有匹配站点才能使用。')}</span></li>
            <li><Check size={15} /><span>{t('密码只在后台解密，并通过短期安全引用填入页面；模型看不到密码明文。')}</span></li>
            <li><Check size={15} /><span>{t('验证码、扫码和二次认证仍需要你在浏览器中完成。')}</span></li>
          </ul>
          <button className="ui-button secondary browser-chat-onboarding-action" onClick={() => onOpenManagement('accounts')} type="button">
            <KeyRound size={16} />{t('打开账号管理')}
          </button>
        </>
      );
    }

    if (activeStep.id === 'skills') {
      return (
        <>
          <div className="browser-chat-onboarding-compare">
            <div><strong>Skill</strong><p>{t('保存方法、规则和判断逻辑。发送前从输入框的 Skill 列表选择，模型会按这套方法完成当前任务。')}</p></div>
            <div><strong>{t('自动化')}</strong><p>{t('保存已经验证过的固定流程，用于再次运行或定时执行。它更适合步骤稳定、输入明确的重复任务。')}</p></div>
          </div>
          <p className="browser-chat-onboarding-note">{t('一次任务成功后，可在 AI 回复下方选择“生成 Skill”或“生成自动化”，再勾选真正需要复用的消息。')}</p>
          <button className="ui-button secondary browser-chat-onboarding-action" onClick={() => onOpenManagement('skills')} type="button">
            <Workflow size={16} />{t('打开 Skill 管理')}
          </button>
        </>
      );
    }

    if (activeStep.id === 'memory') {
      return (
        <>
          <ul className="browser-chat-onboarding-facts">
            <li><Check size={15} /><span>{t('适合保存长期偏好、固定术语、常用格式和某个域名的业务约定。')}</span></li>
            <li><Check size={15} /><span>{t('不应保存密码、验证码、令牌、临时任务数据或大段页面正文。')}</span></li>
            <li><Check size={15} /><span>{t('记忆会按相关性进入后续对话，你可以随时查看、禁用、编辑或删除。')}</span></li>
          </ul>
          <button className="ui-button secondary browser-chat-onboarding-action" onClick={() => onOpenManagement('memory')} type="button">
            <Brain size={16} />{t('打开记忆管理')}
          </button>
        </>
      );
    }

    if (activeStep.id === 'permissions') {
      return (
        <div className="browser-chat-onboarding-mode-options" role="radiogroup" aria-label={t('执行权限')}>
          <button aria-checked={safetyMode === 'strict'} className={safetyMode === 'strict' ? 'is-selected' : undefined} onClick={() => onSafetyModeChange('strict')} role="radio" type="button">
            <span><ShieldCheck size={18} /></span>
            <div><strong>{t('严谨模式')}</strong><p>{t('提交、删除、上传和其他可能产生外部影响的操作会先请求确认。首次使用和重要业务任务建议选择它。')}</p></div>
            {safetyMode === 'strict' ? <Check size={16} /> : null}
          </button>
          <button aria-checked={safetyMode === 'full'} className={safetyMode === 'full' ? 'is-selected' : undefined} onClick={() => onSafetyModeChange('full')} role="radio" type="button">
            <span><Workflow size={18} /></span>
            <div><strong>{t('完全模式')}</strong><p>{t('模型可以连续执行，不再逐项等待确认。仅在目标、权限和影响范围都很明确时使用。')}</p></div>
            {safetyMode === 'full' ? <Check size={16} /> : null}
          </button>
        </div>
      );
    }

    if (activeStep.id === 'model') {
      return (
        <>
          <div className="browser-chat-onboarding-current-model">
            <span><Bot size={18} /></span>
            <div><small>{t('当前模型')}</small><strong>{modelLabel || t('尚未选择可用模型')}</strong></div>
          </div>
          <ul className="browser-chat-onboarding-facts">
            <li><Check size={15} /><span>{t('需要看截图或理解图片时，选择已启用图片输入的模型。')}</span></li>
            <li><Check size={15} /><span>{t('长任务优先选择上下文更大、工具调用更稳定的模型；简单查询可选择速度更快的模型。')}</span></li>
            <li><Check size={15} /><span>{t('输入框右下角切换本轮模型；服务商、Key 和模型列表在设置中配置。')}</span></li>
          </ul>
          <div className="browser-chat-onboarding-action-row">
            <button className="ui-button secondary browser-chat-onboarding-action" onClick={onOpenModelSelector} type="button"><Bot size={16} />{t('选择本轮模型')}</button>
          </div>
        </>
      );
    }

    if (activeStep.id === 'readiness') {
      return (
        <>
          <div className="browser-chat-readiness-grid" aria-label={t('环境检查')}>
            {readinessItems.map(([label, item]) => (
              <div className={item.ready ? 'is-ready' : 'is-warning'} key={label} title={t(item.detail)}>
                <span>{item.ready ? <Check size={14} /> : '!'}</span>
                <div><strong>{label}</strong><small>{t(item.detail)}</small></div>
              </div>
            ))}
          </div>
          <p className="browser-chat-onboarding-note">{t('模型和浏览器是执行网页任务的必要条件；图片输入影响视觉理解，Office 影响 Word、Excel、PPT 和 PDF 的创建、排版与预览。')}</p>
          {!payload?.readiness.model.ready ? <Link className="ui-button secondary browser-chat-onboarding-action" href="/settings"><Settings size={16} />{t('配置模型')}</Link> : null}
        </>
      );
    }

    return (
      <>
        <div className="browser-chat-onboarding-practice">
          <strong>{t('这次演练会自动完成')}</strong>
          <ol>
            <li>{t('打开 WebPilot 内置演练页')}</li>
            <li>{t('读取真实页面状态并定位姓名和部门字段')}</li>
            <li>{t('填写测试内容，但不点击提交')}</li>
            <li>{t('再次读取页面并验证填写结果')}</li>
          </ol>
        </div>
        <p className="browser-chat-onboarding-note">{t('演练不会访问真实业务系统，也不会产生外部数据变更。执行过程会直接出现在对话中。')}</p>
      </>
    );
  }

  if (!payload) {
    return <div className="browser-chat-empty-start is-loading"><Loader2 className="spin" size={20} /><span>{t('正在准备工作区')}</span></div>;
  }

  if (!showTutorial) {
    return (
      <section className="browser-chat-empty-start" aria-label={t('开始新对话')}>
        <div className="browser-chat-empty-heading">
          <TextAnimate animation="blurIn" as="span" by="character" duration={0.48} once>
            DOMP WEBPILOT
          </TextAnimate>
          <TextAnimate animation="blurInUp" as="h1" by="character" delay={0.1} duration={0.72} once>
            {t('今天想让浏览器帮你做什么？')}
          </TextAnimate>
          <TextAnimate animation="fadeIn" as="p" by="character" delay={0.24} duration={0.52} once>
            {t('描述目标，剩下的交给我。')}
          </TextAnimate>
        </div>
      </section>
    );
  }

  return (
    <section className="browser-chat-onboarding" aria-label={t('WebPilot 新手教程')}>
      <header className="browser-chat-onboarding-header">
        <div>
          <span className="browser-chat-onboarding-kicker">DOMP WEBPILOT · {t('新手引导')}</span>
          <strong>{t('第 {current} 步，共 {total} 步', { current: activeStepIndex + 1, total: guideSteps.length })}</strong>
        </div>
        <div className="browser-chat-onboarding-progress" aria-hidden="true"><span style={{ width: `${((activeStepIndex + 1) / guideSteps.length) * 100}%` }} /></div>
      </header>

      <div className="browser-chat-onboarding-layout">
        <nav className="browser-chat-onboarding-nav" aria-label={t('新手引导步骤')}>
          {guideSteps.map((step, index) => {
            const completed = payload.state.completedSteps.includes(step.id);
            const selected = step.id === activeStep.id;
            return (
              <button aria-current={selected ? 'step' : undefined} className={`${selected ? 'is-active' : ''}${completed ? ' is-complete' : ''}`} key={step.id} onClick={() => setActiveStepId(step.id)} type="button">
                <span>{completed ? <Check size={13} /> : index + 1}</span>
                <strong>{step.label}</strong>
              </button>
            );
          })}
        </nav>

        <article className="browser-chat-onboarding-card">
          <header>
            <span className="browser-chat-onboarding-step-icon"><ActiveStepIcon size={20} /></span>
            <div><h1>{activeStep.title}</h1><p>{activeStep.description}</p></div>
          </header>
          <div className="browser-chat-onboarding-step-content">{renderStepContent()}</div>
        </article>
      </div>

      {tutorialError ? <div className="error browser-chat-onboarding-error" role="alert">{tutorialError}</div> : null}

      <footer className="browser-chat-onboarding-footer">
        <button className="browser-chat-tutorial-skip" disabled={advancing || starting} onClick={() => void skipTutorial()} type="button">{t('暂时跳过')}</button>
        <div>
          <button className="ui-button secondary" disabled={activeStepIndex === 0 || advancing || starting} onClick={() => setActiveStepId(guideSteps[activeStepIndex - 1]!.id)} type="button"><ArrowLeft size={16} />{t('上一步')}</button>
          {activeStep.id === 'browser_task' ? (
            <button className="ui-button primary" disabled={busy || starting || !payload.readiness.model.ready || !payload.readiness.browser.ready} onClick={() => void startTutorial()} type="button">
              {starting ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />}{t('开始安全演练')}
            </button>
          ) : (
            <button className="ui-button primary" disabled={advancing || starting} onClick={() => void completeCurrentStep()} type="button">
              {advancing ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />}{t('下一步')}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
