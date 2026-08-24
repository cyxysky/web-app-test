'use client';

import { useCallback, useLayoutEffect, useState, type FormEvent } from 'react';
import {
  Bot,
  Brain,
  Braces,
  Bug,
  KeyRound,
  Loader2,
  Lock,
  PanelLeft,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from 'lucide-react';
import { EnvironmentSettings, type EnvironmentSettingsInitialData } from '@/components/EnvironmentSettings';
import {
  environmentSettingsTabsForUser,
  isAdministratorOnlySettingsTab,
} from '@/components/environment-settings-model';
import { WorkspaceModeTabs, WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import type { SettingsTab } from '@/config/settings';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import {
  readSidebarCollapsedPreference,
  writeSidebarCollapsedPreference,
} from '@/lib/sidebar-collapse';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { useTheme } from '@/theme/ThemeProvider';
import { AppInput } from '@/components/ui/app-input';
import { AppModal } from '@/components/ui/app-modal';

function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
  if (tab === 'model') return <Bot size={15} />;
  if (tab === 'browser') return <PanelLeft size={15} />;
  if (tab === 'runtime') return <SquareTerminal size={15} />;
  if (tab === 'skills') return <Braces size={15} />;
  if (tab === 'memory') return <Brain size={15} />;
  if (tab === 'accounts') return <KeyRound size={15} />;
  if (tab === 'debug') return <Bug size={15} />;
  return <SlidersHorizontal size={15} />;
}

export function SettingsWorkspace({
  adminSettingsPasswordRequired = false,
  defaultUserId,
  initialData,
  initialSidebarCollapsed = false,
}: {
  adminSettingsPasswordRequired?: boolean;
  defaultUserId: string;
  initialData?: EnvironmentSettingsInitialData;
  initialSidebarCollapsed?: boolean;
}) {
  const { t } = useI18n();
  const { mode: themeMode, setMode } = useTheme();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [adminSettingsAccessToken, setAdminSettingsAccessToken] = useState('');
  const [pendingAdminSettingsTab, setPendingAdminSettingsTab] = useState<SettingsTab | null>(null);
  const [adminSettingsPassword, setAdminSettingsPassword] = useState('');
  const [adminSettingsPasswordError, setAdminSettingsPasswordError] = useState('');
  const [adminSettingsPasswordSubmitting, setAdminSettingsPasswordSubmitting] = useState(false);
  const visibleSettingsTabs = environmentSettingsTabsForUser(defaultUserId, defaultUserId);
  const selectedTab = visibleSettingsTabs.some((tab) => tab.id === activeTab) ? activeTab : 'general';
  const adminSettingsLocked = adminSettingsPasswordRequired && !adminSettingsAccessToken;

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsedPreference(next);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const stored = readSidebarCollapsedPreference(initialSidebarCollapsed);
    setSidebarCollapsed(stored);
    writeSidebarCollapsedPreference(stored);
  }, [initialSidebarCollapsed]);

  function closeAdminSettingsPasswordDialog() {
    if (adminSettingsPasswordSubmitting) return;
    setPendingAdminSettingsTab(null);
    setAdminSettingsPassword('');
    setAdminSettingsPasswordError('');
  }

  function selectSettingsTab(tab: SettingsTab) {
    if (!visibleSettingsTabs.some((item) => item.id === tab)) return;
    if (adminSettingsLocked && isAdministratorOnlySettingsTab(tab)) {
      setPendingAdminSettingsTab(tab);
      setAdminSettingsPassword('');
      setAdminSettingsPasswordError('');
      return;
    }
    setActiveTab(tab);
  }

  async function submitAdminSettingsPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingAdminSettingsTab || adminSettingsPasswordSubmitting) return;
    setAdminSettingsPasswordSubmitting(true);
    setAdminSettingsPasswordError('');
    try {
      const response = await fetch(withWebPilotBasePath('/api/settings/admin-access'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminSettingsPassword }),
      });
      const data = await readApiJson<{ token?: string }>(response, t('管理员设置密码验证失败'));
      if (!data.token) throw new Error(t('管理员设置访问令牌无效'));
      const nextTab = pendingAdminSettingsTab;
      setAdminSettingsAccessToken(data.token);
      setActiveTab(nextTab);
      setPendingAdminSettingsTab(null);
      setAdminSettingsPassword('');
    } catch (error) {
      setAdminSettingsPasswordError(error instanceof Error ? error.message : t('管理员设置密码验证失败'));
    } finally {
      setAdminSettingsPasswordSubmitting(false);
    }
  }

  return (
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed settings-workspace-route' : 'browser-chat-layout settings-workspace-route'}>
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        collapseLabel={sidebarCollapsed ? t('展开侧边栏') : t('折叠侧边栏')}
        onToggleCollapse={toggleSidebarCollapsed}
        onThemeChange={setMode}
        themeMode={themeMode}
        themeToggleLabel={themeMode === 'dark' ? t('切换到浅色模式') : t('切换到深色模式')}
        themeToggleTitle={themeMode === 'dark' ? t('浅色模式') : t('深色模式')}
      >
        <WorkspaceModeTabs
          activeKey="/settings"
          aiOperationsLabel={t('AI 运营')}
          ariaLabel={t('工作模式')}
          automationLabel={t('自动化')}
          collapsed={sidebarCollapsed}
          conversationLabel={t('对话模式')}
          settingsLabel={t('设置')}
          showAiOperations={defaultUserId === '1'}
        />
        <section className="browser-chat-sidebar-section browser-chat-settings-section">
          <nav className="browser-chat-subnav" aria-label={t('环境配置分类')}>
            {visibleSettingsTabs.map((tab) => (
              <button
                aria-current={selectedTab === tab.id ? 'page' : undefined}
                aria-label={t(tab.label)}
                className={selectedTab === tab.id ? 'active' : undefined}
                key={tab.id}
                onClick={() => selectSettingsTab(tab.id)}
                title={t(tab.label)}
                type="button"
              >
                <SettingsTabIcon tab={tab.id} />
                <span>{t(tab.label)}</span>
                {adminSettingsLocked && isAdministratorOnlySettingsTab(tab.id)
                  ? <Lock className="browser-chat-settings-tab-lock" size={13} />
                  : null}
              </button>
            ))}
          </nav>
        </section>
      </WorkspaceSidebar>

      <main className="browser-chat-main">
        <div className="browser-chat-settings-pane">
          <EnvironmentSettings
            activeTab={selectedTab}
            adminSettingsAccessToken={adminSettingsAccessToken}
            adminSettingsPasswordRequired={adminSettingsPasswordRequired}
            defaultUserId={defaultUserId}
            embedded
            initialData={initialData}
            key={adminSettingsAccessToken || 'admin-settings-locked'}
            onActiveTabChange={selectSettingsTab}
            showTabs
            userId={defaultUserId}
          />
        </div>
      </main>

      {pendingAdminSettingsTab ? (
        <AppModal
          ariaLabelledBy="admin-settings-password-title"
          dismissable={!adminSettingsPasswordSubmitting}
          keyboardDismissable={!adminSettingsPasswordSubmitting}
          onClose={closeAdminSettingsPasswordDialog}
          size="sm"
        >
          <form className="webpilot-modal-form" onSubmit={(event) => void submitAdminSettingsPassword(event)}>
            <header className="ui-modal-header">
              <div className="ui-modal-heading">
                <h2 className="ui-modal-title" id="admin-settings-password-title">{t('管理员设置验证')}</h2>
                <p className="ui-modal-subtitle">{t('这些配置仅供管理员使用。进入前需要验证管理员密码。')}</p>
              </div>
              <button
                aria-label={t('关闭')}
                className="ui-icon-button ui-modal-close"
                disabled={adminSettingsPasswordSubmitting}
                onClick={closeAdminSettingsPasswordDialog}
                type="button"
              >
                <X size={16} />
              </button>
            </header>
            <div className="ui-modal-body admin-settings-password-form">
              <label>
                <span>{t('管理员密码')}</span>
                <AppInput
                  autoComplete="current-password"
                  autoFocus
                  disabled={adminSettingsPasswordSubmitting}
                  maxLength={1_024}
                  onChange={(event) => setAdminSettingsPassword(event.target.value)}
                  prefix={<KeyRound aria-hidden="true" size={16} />}
                  type="password"
                  value={adminSettingsPassword}
                />
              </label>
              {adminSettingsPasswordError ? <div className="error" role="alert">{adminSettingsPasswordError}</div> : null}
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={adminSettingsPasswordSubmitting} onClick={closeAdminSettingsPasswordDialog} type="button">
                {t('取消')}
              </button>
              <button className="ui-button ui-button--primary" disabled={adminSettingsPasswordSubmitting || !adminSettingsPassword} type="submit">
                {adminSettingsPasswordSubmitting ? <Loader2 className="spin" size={15} /> : <Lock size={15} />}
                {adminSettingsPasswordSubmitting ? t('正在验证') : t('解锁管理员设置')}
              </button>
            </footer>
          </form>
        </AppModal>
      ) : null}
    </section>
  );
}
