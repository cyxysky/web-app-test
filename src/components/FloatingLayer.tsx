'use client';

import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

type FloatingLayerPlacement = 'auto' | 'bottom' | 'top';
type FloatingLayerAlign = 'end' | 'start';

type FloatingLayerProps = {
  active?: boolean;
  align?: FloatingLayerAlign;
  allowNestedFloatingLayers?: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel?: string;
  children: ReactNode;
  className: string;
  id?: string;
  layerRef?: RefObject<HTMLDivElement | null>;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  onDismiss: () => void;
  placement?: FloatingLayerPlacement;
  preferredWidth?: number;
  present: boolean;
  role?: 'dialog' | 'listbox' | 'menu';
  style?: CSSProperties;
};

const floatingInset = 8;
const floatingGap = 6;
const modalFloatingLayerZIndex = 2147483003;
const hiddenLayoutStyle: CSSProperties = {
  left: 0,
  position: 'fixed',
  top: 0,
  visibility: 'hidden',
};

export function floatingLayerZIndex(anchor: Pick<HTMLElement, 'closest'>) {
  const parentFloatingLayer = anchor.closest('.ui-floating-layer');
  if (parentFloatingLayer) {
    const parentZIndex = Number.parseInt(window.getComputedStyle(parentFloatingLayer).zIndex, 10);
    if (Number.isFinite(parentZIndex)) return parentZIndex + 1;
  }
  return anchor.closest('[aria-modal="true"]') ? modalFloatingLayerZIndex : undefined;
}

function floatingLayerPortalTarget(anchor: HTMLElement | null) {
  if (typeof document === 'undefined') return null;
  return anchor?.closest<HTMLElement>('[role="dialog"]') || document.body;
}

function viewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  return { bottom: top + height, height, left, right: left + width, top, width };
}

export function FloatingLayer({
  active = true,
  align = 'end',
  allowNestedFloatingLayers = false,
  anchorRef,
  ariaLabel,
  children,
  className,
  id,
  layerRef,
  matchAnchorWidth = false,
  maxHeight = 520,
  onDismiss,
  placement = 'auto',
  preferredWidth,
  present,
  role,
  style,
}: FloatingLayerProps) {
  const internalLayerRef = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef(onDismiss);
  const [portalReady, setPortalReady] = useState(false);
  const [layoutStyle, setLayoutStyle] = useState<CSSProperties>(hiddenLayoutStyle);
  const [resolvedPlacement, setResolvedPlacement] = useState<'bottom' | 'top'>('bottom');

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!present) setLayoutStyle(hiddenLayoutStyle);
  }, [present]);

  const setLayerNode = useCallback((node: HTMLDivElement | null) => {
    internalLayerRef.current = node;
    if (layerRef) (layerRef as { current: HTMLDivElement | null }).current = node;
  }, [layerRef]);

  const updateLayout = useCallback(() => {
    const anchor = anchorRef.current;
    const layer = internalLayerRef.current;
    if (!anchor || !layer) return;

    const portalTarget = floatingLayerPortalTarget(anchor);
    if (!portalTarget) return;

    const bounds = viewportBounds();
    const anchorRect = anchor.getBoundingClientRect();
    const availableWidth = Math.max(0, bounds.width - floatingInset * 2);
    const naturalWidth = preferredWidth || (matchAnchorWidth ? anchorRect.width : Math.max(layer.offsetWidth, layer.scrollWidth));
    const width = Math.min(Math.max(0, naturalWidth), availableWidth);
    const spaceBelow = Math.max(0, bounds.bottom - anchorRect.bottom - floatingGap - floatingInset);
    const spaceAbove = Math.max(0, anchorRect.top - bounds.top - floatingGap - floatingInset);
    const desiredHeight = Math.min(maxHeight, layer.scrollHeight);
    const nextPlacement = placement === 'top'
      ? (spaceAbove >= Math.min(desiredHeight, 120) || spaceAbove >= spaceBelow ? 'top' : 'bottom')
      : placement === 'bottom'
        ? (spaceBelow >= Math.min(desiredHeight, 120) || spaceBelow >= spaceAbove ? 'bottom' : 'top')
        : spaceBelow >= desiredHeight || spaceBelow >= spaceAbove
          ? 'bottom'
          : 'top';
    const availableHeight = Math.max(80, Math.min(maxHeight, nextPlacement === 'bottom' ? spaceBelow : spaceAbove));
    const renderedHeight = Math.min(desiredHeight, availableHeight);
    const preferredLeft = align === 'start' ? anchorRect.left : anchorRect.right - width;
    const left = Math.min(
      Math.max(preferredLeft, bounds.left + floatingInset),
      Math.max(bounds.left + floatingInset, bounds.right - width - floatingInset),
    );
    const top = nextPlacement === 'bottom'
      ? Math.min(anchorRect.bottom + floatingGap, bounds.bottom - renderedHeight - floatingInset)
      : Math.max(bounds.top + floatingInset, anchorRect.top - renderedHeight - floatingGap);
    const portalledIntoDialog = portalTarget !== document.body;
    const portalRect = portalledIntoDialog ? portalTarget.getBoundingClientRect() : null;
    const positionedLeft = portalRect
      ? left - portalRect.left - portalTarget.clientLeft + portalTarget.scrollLeft
      : left;
    const positionedTop = portalRect
      ? top - portalRect.top - portalTarget.clientTop + portalTarget.scrollTop
      : top;

    setResolvedPlacement(nextPlacement);
    setLayoutStyle((current) => {
      const next: CSSProperties = {
        bottom: 'auto',
        left: Math.round(positionedLeft),
        maxHeight: Math.floor(availableHeight),
        maxWidth: availableWidth,
        position: portalledIntoDialog ? 'absolute' : 'fixed',
        right: 'auto',
        top: Math.round(positionedTop),
        visibility: 'visible',
        width: matchAnchorWidth || preferredWidth ? Math.round(width) : undefined,
      };
      const zIndex = floatingLayerZIndex(anchor);
      if (zIndex) next.zIndex = zIndex;
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [align, anchorRef, matchAnchorWidth, maxHeight, placement, preferredWidth]);

  useLayoutEffect(() => {
    if (!portalReady || !present) return undefined;
    let frame = window.requestAnimationFrame(updateLayout);
    const scheduleLayout = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateLayout);
    };
    const resizeObserver = new ResizeObserver(scheduleLayout);
    if (anchorRef.current) resizeObserver.observe(anchorRef.current);
    if (internalLayerRef.current) resizeObserver.observe(internalLayerRef.current);
    document.addEventListener('scroll', scheduleLayout, true);
    window.addEventListener('resize', scheduleLayout);
    window.visualViewport?.addEventListener('resize', scheduleLayout);
    window.visualViewport?.addEventListener('scroll', scheduleLayout);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener('scroll', scheduleLayout, true);
      window.removeEventListener('resize', scheduleLayout);
      window.visualViewport?.removeEventListener('resize', scheduleLayout);
      window.visualViewport?.removeEventListener('scroll', scheduleLayout);
    };
  }, [anchorRef, portalReady, present, updateLayout]);

  useEffect(() => {
    if (!active || !present) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || internalLayerRef.current?.contains(target)) return;
      if (allowNestedFloatingLayers && target instanceof Element && target.closest('.ui-floating-layer')) return;
      dismissRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dismissRef.current();
      anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', closeOnPointerDown, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [active, allowNestedFloatingLayers, anchorRef, present]);

  if (!portalReady || !present) return null;
  const portalTarget = floatingLayerPortalTarget(anchorRef.current);
  if (!portalTarget) return null;
  return createPortal((
    <div
      aria-label={ariaLabel}
      className={`ui-floating-layer ${className}`}
      data-floating-placement={resolvedPlacement}
      id={id}
      ref={setLayerNode}
      role={role}
      style={{ ...style, ...layoutStyle }}
    >
      {children}
    </div>
  ), portalTarget);
}
