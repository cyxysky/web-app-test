'use client';

import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { useI18n } from '@/i18n/I18nProvider';

export default function Loading() {
  const { t } = useI18n();
  return (
    <div className="navigation-loading-overlay" role="status" aria-live="polite" aria-label={t('页面切换中')}>
      <div className="navigation-loading-content">
        <LiquidGlassLoader />
        <p>{t('正在切换界面')}</p>
      </div>
    </div>
  );
}
