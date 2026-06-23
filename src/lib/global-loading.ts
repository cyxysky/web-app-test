'use client';

type LoadingDetail = {
  label?: string;
};

export function startGlobalLoading(label?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<LoadingDetail>('navigation-loading:start', { detail: { label } }));
}

export function stopGlobalLoading() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('navigation-loading:stop'));
}
