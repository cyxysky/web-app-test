'use client';

import { Moon, PanelLeft, Sun } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ThemeMode } from '@/theme/ThemeProvider';
import { WebPilotHelpCenter } from '@/components/WebPilotHelpCenter';

type WorkspaceSidebarProps = {
  children: ReactNode;
  className?: string;
  collapsed: boolean;
  collapseLabel: string;
  onToggleCollapse: () => void;
  onToggleTheme: () => void;
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
  if (onClick) {
    return (
      <button aria-current={active ? 'page' : undefined} aria-label={label} className={className} onClick={onClick} title={label} type="button">
        {icon}
        <span>{label}</span>
      </button>
    );
  }
  if (!href) return null;
  return (
    <Link aria-current={active ? 'page' : undefined} aria-label={label} className={className} href={href} title={label}>
      {icon}
      <span>{label}</span>
    </Link>
  );
}

export function WorkspaceSidebar({
  children,
  className,
  collapsed,
  collapseLabel,
  onToggleCollapse,
  onToggleTheme,
  themeMode,
  themeToggleLabel,
  themeToggleTitle,
}: WorkspaceSidebarProps) {
  return (
    <aside className={className ? `browser-chat-sidebar ${className}` : 'browser-chat-sidebar'}>
      <div className="browser-chat-brand">
        <strong>WebPilot</strong>
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
          justifyContent: collapsed ? 'center' : 'flex-end',
        }}
      >
        <WebPilotHelpCenter collapsed={collapsed} />
        <button
          aria-label={themeToggleLabel}
          className="browser-chat-theme-toggle"
          onClick={onToggleTheme}
          title={themeToggleTitle}
          type="button"
        >
          {themeMode === 'dark' ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
        </button>
      </div>
    </aside>
  );
}
