type LiquidGlassLoaderProps = {
  className?: string;
};

export function LiquidGlassLoader({ className = '' }: LiquidGlassLoaderProps) {
  return (
    <span aria-hidden="true" className={`ui-liquid-glass-loader ${className}`.trim()}>
      <i className="ui-loading-dot" />
      <i className="ui-loading-dot" />
      <i className="ui-loading-dot" />
    </span>
  );
}
