'use client';

import dynamic from 'next/dynamic';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { useI18n } from '@/i18n/I18nProvider';

function BrowserChatLoading() {
  const { t } = useI18n();
  return (
    <div className="workspace-route-loading" role="status">
      <LiquidGlassLoader />
      <span>{t('正在加载浏览器工作区')}</span>
    </div>
  );
}

const BrowserChatWorkspace = dynamic(
  () => import('@/components/BrowserChatWorkspace').then((module) => module.BrowserChatWorkspace),
  {
    ssr: false,
    loading: () => <BrowserChatLoading />,
  },
);

export function BrowserChatWorkspaceLoader(props: {
  defaultUserId: string;
  initialSidebarCollapsed?: boolean;
}) {
  return <BrowserChatWorkspace {...props} />;
}
