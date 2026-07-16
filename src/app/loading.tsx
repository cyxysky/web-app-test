import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';

export default function Loading() {
  return (
    <div className="navigation-loading-overlay" role="status" aria-live="polite" aria-label="页面切换中">
      <div className="navigation-loading-content">
        <LiquidGlassLoader />
        <p>正在切换界面</p>
      </div>
    </div>
  );
}
