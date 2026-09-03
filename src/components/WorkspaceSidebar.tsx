'use client';

import { Gauge, MessageCircleMore, PanelLeft, Settings, Workflow } from 'lucide-react';
import { Tabs } from '@heroui/react/tabs';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { ThemeMode } from '@/theme/ThemeProvider';
import { WebPilotHelpCenter } from '@/components/WebPilotHelpCenter';
import { AnimatedThemeToggler } from '@/components/ui/animated-theme-toggler';
import { AuroraText } from '@/components/ui/aurora-text';

type WorkspaceSidebarProps = {
  children: ReactNode;
  className?: string;
  collapsed: boolean;
  collapseLabel: string;
  onToggleCollapse: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  themeMode: ThemeMode;
  themeToggleLabel: string;
  themeToggleTitle: string;
};

type WorkspaceModeKey = '/browser-chat' | '/automation' | '/admin/ai-operations' | '/settings';

type WorkspaceModeTabsProps = {
  activeKey: WorkspaceModeKey;
  aiOperationsLabel: string;
  ariaLabel: string;
  automationLabel: string;
  collapsed: boolean;
  conversationLabel: string;
  settingsLabel: string;
  showAiOperations?: boolean;
};

type WorkspaceNavigationSidebarProps = Pick<
  WorkspaceSidebarProps,
  'children' | 'className' | 'collapsed' | 'onThemeChange' | 'onToggleCollapse' | 'themeMode'
> & {
  activeKey: WorkspaceModeKey;
  showAiOperations?: boolean;
  translate: (value: string) => string;
};

export function WorkspaceModeTabs({
  activeKey,
  aiOperationsLabel,
  ariaLabel,
  automationLabel,
  conversationLabel,
  settingsLabel,
  showAiOperations = false,
}: WorkspaceModeTabsProps) {
  const router = useRouter();
  const [desktopLayout, setDesktopLayout] = useState(false);
  const visibleConversationLabel = conversationLabel.replace(/(?:模式| Mode)$/u, '');

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1025px)');
    const syncDesktopLayout = () => setDesktopLayout(desktopQuery.matches);
    syncDesktopLayout();
    desktopQuery.addEventListener('change', syncDesktopLayout);
    return () => desktopQuery.removeEventListener('change', syncDesktopLayout);
  }, []);

  return (
    <Tabs
      className="workspace-mode-tabs"
      onSelectionChange={(key) => {
        const nextKey = String(key) as WorkspaceModeKey;
        if (nextKey !== activeKey) router.push(nextKey);
      }}
      orientation={desktopLayout ? 'vertical' : 'horizontal'}
      selectedKey={activeKey}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label={ariaLabel}>
          <Tabs.Tab aria-label={conversationLabel} id="/browser-chat">
            <MessageCircleMore aria-hidden="true" />
            <span className="workspace-mode-tab-label">{visibleConversationLabel}</span>
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab aria-label={automationLabel} id="/automation">
            <Workflow aria-hidden="true" />
            <span className="workspace-mode-tab-label">{automationLabel}</span>
            <Tabs.Indicator />
          </Tabs.Tab>
          {showAiOperations ? (
            <Tabs.Tab aria-label={aiOperationsLabel} id="/admin/ai-operations">
              <Gauge aria-hidden="true" />
              <span className="workspace-mode-tab-label">{aiOperationsLabel}</span>
              <Tabs.Indicator />
            </Tabs.Tab>
          ) : null}
          <Tabs.Tab aria-label={settingsLabel} id="/settings">
            <Settings aria-hidden="true" />
            <span className="workspace-mode-tab-label">{settingsLabel}</span>
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

export function WorkspaceSidebar({
  children,
  className,
  collapsed,
  collapseLabel,
  onToggleCollapse,
  onThemeChange,
  themeMode,
  themeToggleLabel,
  themeToggleTitle,
}: WorkspaceSidebarProps) {
  return (
    <aside className={className ? `browser-chat-sidebar ${className}` : 'browser-chat-sidebar'}>
      <div className="browser-chat-brand">
        <strong className="browser-chat-brand-title">
          <AuroraText className="browser-chat-brand-aurora" speed={1.2}>DOMP</AuroraText>
          <span>WebPilot</span>
        </strong>
        <button
          aria-label={collapseLabel}
          className="ui-icon-button"
          onClick={onToggleCollapse}
          title={collapseLabel}
          type="button"
        >
          <PanelLeft aria-hidden="true" size={18} />
        </button>
      </div>

      {children}

      <div
        className="browser-chat-sidebar-footer"
        style={{
          alignItems: 'center',
          display: 'flex',
          flexDirection: collapsed ? 'column' : 'row',
          gap: collapsed ? 2 : undefined,
          justifyContent: collapsed ? 'center' : 'space-between',
        }}
      >
        <WebPilotHelpCenter collapsed={collapsed} />
        <AnimatedThemeToggler
          aria-label={themeToggleLabel}
          className="browser-chat-theme-toggle"
          duration={600}
          onThemeChange={onThemeChange}
          theme={themeMode}
          title={themeToggleTitle}
        />
      </div>
    </aside>
  );
}

export function WorkspaceNavigationSidebar({
  activeKey,
  children,
  className,
  collapsed,
  onThemeChange,
  onToggleCollapse,
  showAiOperations,
  themeMode,
  translate,
}: WorkspaceNavigationSidebarProps) {
  const lightTheme = themeMode === 'dark';
  return (
    <WorkspaceSidebar
      className={className}
      collapsed={collapsed}
      collapseLabel={translate(collapsed ? '展开侧边栏' : '折叠侧边栏')}
      onToggleCollapse={onToggleCollapse}
      onThemeChange={onThemeChange}
      themeMode={themeMode}
      themeToggleLabel={translate(lightTheme ? '切换到浅色模式' : '切换到深色模式')}
      themeToggleTitle={translate(lightTheme ? '浅色模式' : '深色模式')}
    >
      <WorkspaceModeTabs
        activeKey={activeKey}
        aiOperationsLabel={translate('AI 运营')}
        ariaLabel={translate('工作模式')}
        automationLabel={translate('自动化')}
        collapsed={collapsed}
        conversationLabel={translate('对话模式')}
        settingsLabel={translate('设置')}
        showAiOperations={showAiOperations}
      />
      {children}
    </WorkspaceSidebar>
  );
}
