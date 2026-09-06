import type { CSSProperties } from 'react';

const paths = {
  expand: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5',
  collapse: 'M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3',
  edit: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z',
  download: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
  close: 'm6 6 12 12M6 18 18 6',
  grid: 'M3 3h18v18H3zM3 9h18M9 9v12',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
  chart: 'M4 19V9m8 10V4m8 15v-7',
  image: 'M3 3h18v18H3zM3 17l5-5 4 4 4-6 5 7M7 7h.01',
  check: 'm5 12 4 4L19 6',
} as const;

export function ChartIcon({ name, style }: { name: keyof typeof paths; style?: CSSProperties }) {
  // Keep the icon in its own slot so host button > svg selectors cannot classify
  // text actions (including confirm and tabs) as icon-only controls.
  return <span className="capability-chart-icon-slot" aria-hidden="true"><svg className="capability-chart-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false" style={style}><path d={paths[name]} /></svg></span>;
}
