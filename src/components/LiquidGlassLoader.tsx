import type { CSSProperties } from 'react';

type LiquidGlassLoaderProps = {
  className?: string;
};

export function LiquidGlassLoader({ className = '' }: LiquidGlassLoaderProps) {
  return (
    <span aria-hidden="true" className={`ui-liquid-glass-loader ${className}`.trim()}>
      <span className="ui-liquid-glass-orb">
        <span className="ui-liquid-glass-water" />
        <i className="ui-liquid-glass-bubble" style={{ '--x': '34%', '--delay': '-.2s' } as CSSProperties} />
        <i className="ui-liquid-glass-bubble ui-liquid-glass-bubble--small" style={{ '--x': '57%', '--delay': '-1.4s' } as CSSProperties} />
        <i className="ui-liquid-glass-bubble ui-liquid-glass-bubble--large" style={{ '--x': '69%', '--delay': '-2.1s' } as CSSProperties} />
        <span className="ui-liquid-glass-glint" />
      </span>
    </span>
  );
}
