'use client';

import { PanelLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ThemeMode } from '@/theme/ThemeProvider';
import { WebPilotHelpCenter } from '@/components/WebPilotHelpCenter';
import { AnimatedThemeToggler } from '@/components/ui/animated-theme-toggler';

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

type WorkspaceNavItemProps = {
  active?: boolean;
  href?: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
};

export function WorkspaceNavItem({ active = false, href, icon, label, onClick }: WorkspaceNavItemProps) {
  const className = active ? 'browser-chat-nav-item active' : 'browser-chat-nav-item';
  const visibleLabel = href === '/browser-chat' ? label.replace(/(?:模式| Mode)$/u, '') : label;

  if (onClick) {
    return (
      <button aria-current={active ? 'page' : undefined} aria-label={label} className={className} onClick={onClick} title={label} type="button">
        {icon}
        <span>{visibleLabel}</span>
      </button>
    );
  }
  if (!href) return null;
  return (
    <Link aria-current={active ? 'page' : undefined} aria-label={label} className={className} href={href} title={label}>
      {icon}
      <span>{visibleLabel}</span>
    </Link>
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
        <strong>DOMP WebPilot</strong>
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
