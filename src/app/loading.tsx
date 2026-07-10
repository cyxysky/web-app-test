export default function Loading() {
  return (
    <div className="navigation-loading-overlay" role="status" aria-live="polite" aria-label="页面切换中">
      <div className="navigation-loading-content">
        <span aria-hidden="true" className="ui-loading-spinner ui-loading-spinner--large" />
        <p>正在切换界面</p>
      </div>
    </div>
  );
}
