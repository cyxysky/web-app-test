import type {
  AccessibilitySnapshotExportControlResult,
  BrowserActiveSurface,
  BrowserPageObservation,
  BrowserUseDomDelta,
  BrowserUseDomJournalDelta,
  BrowserUseViewportClip,
  BrowserUseVisibleDomSnapshot,
  DomActionCapability,
  DomActionConfidence,
  PageDomObservationPayload,
  PageInteractiveCandidate,
  WindowWithAiDomRuntime,
} from './browser-session.js';

export const AI_DOM_RUNTIME_VERSION = 28;

export function installAccessibilitySnapshotExportControl() {
  if (window.top !== window) return;
  const controlId = '__ai_dom_export_control__';
  const browserWindow = window as Window & {
    __webPilotExportAccessibilitySnapshot?: () => Promise<AccessibilitySnapshotExportControlResult>;
  };
  const mount = () => {
    if (!document.documentElement || document.getElementById(controlId)) return;
    const button = document.createElement('button');
    button.id = controlId;
    button.type = 'button';
    button.textContent = '导出页面快照';
    button.title = '获取当前页面及全部 iframe 的语义 DOM 快照，并按每段 20000 字符导出 JSON';
    button.setAttribute('aria-label', '导出当前页面语义 DOM 快照');
    Object.assign(button.style, {
      alignItems: 'center',
      appearance: 'none',
      background: '#171717',
      border: '1px solid rgba(255,255,255,.18)',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,.24)',
      color: '#fff',
      cursor: 'pointer',
      display: 'inline-flex',
      font: '600 13px/1 system-ui, sans-serif',
      height: '34px',
      padding: '0 12px',
      position: 'fixed',
      right: '16px',
      top: '16px',
      zIndex: '2147483647',
    });
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.style.cursor = 'wait';
      button.textContent = '正在采集...';
      try {
        const result = await browserWindow.__webPilotExportAccessibilitySnapshot?.();
        if (!result?.ok) throw new Error(result?.error || '页面快照导出失败');
        button.textContent = '导出完成';
        button.title = result.path || result.fileName || '页面快照已导出';
        if (result.downloadUrl) {
          const link = document.createElement('a');
          link.href = result.downloadUrl;
          link.download = result.fileName || 'accessibility-snapshot.json';
          link.style.display = 'none';
          document.documentElement.appendChild(link);
          link.click();
          link.remove();
        }
      } catch (error) {
        button.textContent = '导出失败';
        button.title = error instanceof Error ? error.message : String(error);
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          button.style.cursor = 'pointer';
          button.textContent = '导出页面快照';
        }, 1800);
      }
    });
    document.documentElement.appendChild(button);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

export function installAiBrowserPageRuntime(runtimeVersion: number) {
  const win = window as WindowWithAiDomRuntime;
  const mouseCursorId = '__ai_mouse_cursor__';
  const mountMouseCursor = () => {
    const existing = document.getElementById(mouseCursorId);
    if (existing) return existing;
    if (!document.documentElement) return undefined;
    const cursor = document.createElement('div');
    cursor.id = mouseCursorId;
    cursor.setAttribute('aria-hidden', 'true');
    const startX = Math.max(0, Math.round(window.innerWidth / 2));
    const startY = Math.max(0, Math.round(window.innerHeight / 2));
    cursor.dataset.x = String(startX);
    cursor.dataset.y = String(startY);
    Object.assign(cursor.style, {
      contain: 'layout style paint',
      height: '34px',
      left: '0',
      opacity: '0',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      transform: `translate3d(${startX}px, ${startY}px, 0)`,
      transformOrigin: '0 0',
      width: '30px',
      willChange: 'transform, opacity',
      zIndex: '2147483647',
    });
    const pointer = document.createElement('div');
    const cursorSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="23" height="30" viewBox="0 0 32 42">',
      '<path d="M4 3v28.5l7.3-6.9 4.7 12.2 5.6-2.2-4.8-11.8h10.6L4 3z" fill="white" stroke="#111827" stroke-width="2.2" stroke-linejoin="round"/>',
      '<circle cx="25" cy="8" r="5" fill="#2563eb" stroke="white" stroke-width="2"/>',
      '</svg>',
    ].join('');
    Object.assign(pointer.style, {
      backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(cursorSvg)}")`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: '23px 30px',
      filter: 'drop-shadow(0 3px 5px rgba(0, 0, 0, 0.42))',
      height: '30px',
      left: '0',
      position: 'absolute',
      top: '0',
      width: '23px',
    });
    const pulse = document.createElement('div');
    pulse.dataset.aiMousePulse = 'true';
    Object.assign(pulse.style, {
      border: '2px solid rgba(37, 99, 235, .9)',
      borderRadius: '999px',
      height: '18px',
      left: '-8px',
      opacity: '0',
      position: 'absolute',
      top: '-8px',
      width: '18px',
    });
    cursor.append(pointer, pulse);
    document.documentElement.appendChild(cursor);
    return cursor;
  };
  Object.defineProperty(win, '__aiMoveMouseCursor', {
    configurable: true,
    enumerable: false,
    value: (rawX: number, rawY: number, options: { kind?: string } = {}) => {
      const cursor = mountMouseCursor();
      if (!cursor) return;
      const x = Math.max(0, Math.min(Math.round(Number(rawX) || 0), Math.max(0, window.innerWidth - 1)));
      const y = Math.max(0, Math.min(Math.round(Number(rawY) || 0), Math.max(0, window.innerHeight - 1)));
      cursor.dataset.x = String(x);
      cursor.dataset.y = String(y);
      cursor.style.opacity = '1';
      cursor.style.transition = 'none';
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (options.kind === 'click' || options.kind === 'double' || options.kind === 'right') {
        const pulse = cursor.querySelector<HTMLElement>('[data-ai-mouse-pulse="true"]');
        pulse?.animate([
          { opacity: 0.9, transform: 'scale(.35)' },
          { opacity: 0, transform: 'scale(1.65)' },
        ], { duration: 320, easing: 'ease-out' });
      }
    },
    writable: false,
  });
  if (!win.__aiBrowserPageRuntimeInstalled) {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const listenerTypes = new WeakMap<EventTarget, Set<string>>();
    const interestingEvents = /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/i;

    Object.defineProperty(window, '__aiGetEventListenerTypes', {
      configurable: true,
      enumerable: false,
      value(target: EventTarget) {
        return Array.from(listenerTypes.get(target) || []);
      },
    });

    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (this instanceof Element && interestingEvents.test(String(type))) {
        let types = listenerTypes.get(this);
        if (!types) {
          types = new Set<string>();
          listenerTypes.set(this, types);
        }
        types.add(String(type));
      }
      return originalAddEventListener.call(this, type, listener, options);
    };

    win.__aiBrowserPageRuntimeInstalled = true;
  }

  const mutationState = win.__aiDomMutationState || { epoch: 0, lastMutationAt: Date.now() };
  win.__aiDomMutationState = mutationState;
  if (!mutationState.observer) {
    mutationState.observer = new MutationObserver((mutations) => {
      const relevantMutations = mutations.filter((mutation) => !(
        mutation.type === 'attributes'
        && mutation.attributeName === 'data-ai-browser-code-uid'
      ));
      const meaningful = relevantMutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !target?.closest?.('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__');
      });
      if (!meaningful) return;
      mutationState.pendingMutations = mutationState.pendingMutations || [];
      mutationState.pendingMutationKeys = mutationState.pendingMutationKeys || new WeakMap<Node, Set<string>>();
      mutationState.journalMutations = mutationState.journalMutations || [];
      for (const mutation of relevantMutations) {
        if (mutationState.journalMutations.length >= 10000) mutationState.journalOverflow = true;
        else mutationState.journalMutations.push(mutation);
        if (mutationState.pendingMutations.length >= 500) {
          mutationState.pendingOverflow = true;
          continue;
        }
        if (mutation.type !== 'childList') {
          const key = mutation.type === 'attributes' ? `attributes:${mutation.attributeName || ''}` : mutation.type;
          let keys = mutationState.pendingMutationKeys.get(mutation.target);
          if (!keys) {
            keys = new Set<string>();
            mutationState.pendingMutationKeys.set(mutation.target, keys);
          }
          if (keys.has(key)) continue;
          keys.add(key);
        }
        mutationState.pendingMutations.push(mutation);
      }
      mutationState.epoch += 1;
      mutationState.lastMutationAt = Date.now();
    });
    mutationState.observer.observe(document, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  if (win.__aiDomRuntime?.version === runtimeVersion) return;

  const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'wbr']);
  const nativeActionableTags = new Set(['button', 'details', 'input', 'option', 'select', 'summary', 'textarea']);
  const normalize = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();

  function isOverlay(element: Element) {
    return Boolean(element.closest('#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__'));
  }

  function shadowRootOf(element: Element) {
    return (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot || undefined;
  }

  function flatParentElement(node: Node): Element | undefined {
    const parent: Node | null = node.parentNode;
    if (!parent) return undefined;
    if (parent.nodeType === Node.ELEMENT_NODE) return parent as Element;
    return (parent as ShadowRoot).host || undefined;
  }

  function composedContains(ancestor: Element, node: Element) {
    let current: Element | undefined = node;
    let guard = 0;
    while (current && guard < 256) {
      if (current === ancestor) return true;
      current = flatParentElement(current);
      guard += 1;
    }
    return false;
  }

  function isTraversable(element: Element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isOverlay(element)) return false;
    return !skippedTags.has(element.tagName.toLowerCase());
  }

  function isDisplayNone(element: Element) {
    try {
      return window.getComputedStyle(element).display === 'none';
    } catch {
      return false;
    }
  }

  function children(element: Element) {
    if (isDisplayNone(element)) return [];
    const list = Array.from(element.children);
    const root = shadowRootOf(element);
    if (root) list.push(...Array.from(root.children));
    return list.filter(isTraversable);
  }

  function isRenderable(element: Element, options: { requirePointerEvents?: boolean } = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isOverlay(element)) return false;
    const tag = element.tagName.toLowerCase();
    if (skippedTags.has(tag)) return false;
    if (element.hasAttribute('hidden')) return false;
    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (options.requirePointerEvents && style.pointerEvents === 'none') return false;
    if (Number(style.opacity || '1') <= 0.01) return false;
    return true;
  }

  function visibleRect(element: Element, options: { requirePointerEvents?: boolean } = {}) {
    if (!isRenderable(element, options)) return undefined;
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const width = right - left;
    const height = bottom - top;
    if (width <= 2 || height <= 2) return undefined;
    return { left, top, right, bottom, width, height, raw: rect };
  }

  function elementBox(element: Element) {
    if (!isRenderable(element)) return undefined;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return undefined;
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const width = right - left;
    const height = bottom - top;
    const visible = width > 2 && height > 2 ? { left, top, right, bottom, width, height } : undefined;
    const vertical = rect.bottom < 0 ? 'above' : rect.top > window.innerHeight ? 'below' : 'overlaps-y';
    const horizontal = rect.right < 0 ? 'left' : rect.left > window.innerWidth ? 'right' : 'overlaps-x';
    return { raw: rect, visible, vertical, horizontal };
  }

  function recordedEventTypes(element: Element) {
    try {
      return (win.__aiGetEventListenerTypes?.(element) || []).map((item) => item.toLowerCase());
    } catch {
      return [];
    }
  }

  function hasActionAttribute(element: Element) {
    if (element.hasAttribute('jsaction')) return true;
    for (const attr of Array.from(element.attributes)) {
      if (/^(data-.+?(click|action|href|url|target)|ng-click|@click|v-on:click)$/i.test(attr.name) && attr.value !== 'false') return true;
    }
    return false;
  }

  function hasPointerCursor(element: Element) {
    const style = window.getComputedStyle(element);
    if (!/\bpointer\b/i.test(style.cursor || '')) return false;
    const parent = flatParentElement(element);
    if (!parent) return true;
    const parentStyle = window.getComputedStyle(parent);
    if (!/\bpointer\b/i.test(parentStyle.cursor || '')) return true;
    return /(?:^|;)\s*cursor\s*:\s*pointer\b/i.test(element.getAttribute('style') || '');
  }

  function isContentEditableOwner(element: Element) {
    const value = element.getAttribute('contenteditable');
    return value !== null && value.toLowerCase() !== 'false';
  }

  function labelControlFor(element: Element) {
    if (element.tagName.toLowerCase() !== 'label') return undefined;
    const control = (element as HTMLLabelElement).control || undefined;
    const fallback = control ||
      (element.getAttribute('for') ? document.getElementById(element.getAttribute('for') || '') || undefined : undefined);
    const target = fallback ||
      element.querySelector('button, input, select, textarea, [contenteditable=""], [contenteditable="true"]') ||
      undefined;
    if (!target) return undefined;
    const tag = target.tagName.toLowerCase();
    return ['button', 'input', 'select', 'textarea'].includes(tag) || isContentEditableOwner(target) ? target : undefined;
  }

  function hasNativeActionSignal(element: Element, tag = element.tagName.toLowerCase()) {
    if (tag === 'a') return element.hasAttribute('href');
    if (tag === 'label') return Boolean(labelControlFor(element));
    return nativeActionableTags.has(tag);
  }

  function isActionable(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (hasNativeActionSignal(element, tag)) return true;
    if (element.hasAttribute('onclick') || hasActionAttribute(element)) return true;
    if (recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|mouseenter|mouseover|pointerenter|pointerover)$/.test(type))) return true;
    if (hasPointerCursor(element)) return true;
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;
    return isContentEditableOwner(element);
  }

  function actionableTargetFor(element: Element) {
    let current: Element | undefined = element;
    while (current && current !== document.documentElement) {
      if (isActionable(current)) return current;
      current = flatParentElement(current);
    }
    if (element !== document.documentElement && element !== document.body) {
      const queue = children(element);
      let onlyActionableDescendant: Element | undefined;
      while (queue.length) {
        const candidate = queue.shift() as Element;
        if (isActionable(candidate)) {
          if (onlyActionableDescendant) return element;
          onlyActionableDescendant = candidate;
        }
        queue.push(...children(candidate));
      }
      if (onlyActionableDescendant) return onlyActionableDescendant;
    }
    return element;
  }

  function elementFromPath(pathValue?: string) {
    if (!pathValue) return undefined;
    const parts = String(pathValue).split('.').map((item) => Number(String(item).trim()));
    if (!parts.length || parts[0] !== 0 || parts.some((item) => !Number.isInteger(item) || item < 0)) return undefined;
    let element: Element | undefined = document.documentElement;
    for (const index of parts.slice(1)) {
      element = children(element)[index];
      if (!element) return undefined;
    }
    return element;
  }

  function pathOf(element: Element) {
    const segments: number[] = [];
    let current: Element | undefined = element;
    while (current && current !== document.documentElement) {
      const parent = flatParentElement(current);
      if (!parent) return undefined;
      const siblings = children(parent);
      const index = siblings.indexOf(current);
      if (index < 0) return undefined;
      segments.unshift(index);
      current = parent;
    }
    if (current !== document.documentElement) return undefined;
    return [0, ...segments].join('.');
  }

  function descriptor(element: Element | Document) {
    if (element === document) return 'document';
    const targetElement = element as Element;
    const tag = targetElement.tagName.toLowerCase();
    const id = targetElement.id ? `#${targetElement.id}` : '';
    const classes = typeof targetElement.className === 'string'
      ? targetElement.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
      : '';
    return `${tag}${id}${classes}`;
  }

  function textOf(element: Element, maxLength = 160) {
    return normalize((element as HTMLElement).innerText || element.textContent || '').slice(0, maxLength);
  }

  function topmostRenderableAt(x: number, y: number, options: { requirePointerEvents?: boolean } = {}) {
    let root: Document | ShadowRoot = document;
    let found: Element | undefined;
    for (let guard = 0; guard < 24; guard += 1) {
      const stack = root.elementsFromPoint(x, y) as Element[];
      // Occlusion must follow the visual paint stack. Modal backdrops often use
      // pointer-events:none but still make the covered page unusable for the agent.
      const renderOptions = options.requirePointerEvents
        ? { ...options, requirePointerEvents: false }
        : options;
      const top = stack.find((item) => item && isRenderable(item, renderOptions));
      if (!top) break;
      found = top;
      const sub = shadowRootOf(top);
      if (!sub) break;
      root = sub;
    }
    return found;
  }

  function pointBelongsToElement(element: Element, x: number, y: number, options: { requirePointerEvents?: boolean } = {}) {
    const top = topmostRenderableAt(x, y, options);
    return Boolean(top && (top === element || composedContains(element, top)));
  }

  function visiblePointForElement(element: Element, options: { requirePointerEvents?: boolean } = {}) {
    const rect = visibleRect(element, options);
    if (!rect) return undefined;
    const insetX = Math.min(10, Math.max(1, rect.width / 4));
    const insetY = Math.min(10, Math.max(1, rect.height / 4));
    const samples = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + insetX, rect.top + rect.height / 2],
      [rect.right - insetX, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + insetY],
      [rect.left + rect.width / 2, rect.bottom - insetY],
      [rect.left + insetX, rect.top + insetY],
      [rect.right - insetX, rect.top + insetY],
      [rect.left + insetX, rect.bottom - insetY],
      [rect.right - insetX, rect.bottom - insetY],
    ];
    for (const [x, y] of samples) {
      const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
      const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
      if (pointBelongsToElement(element, px, py, options)) return { x: px, y: py };
    }
    return undefined;
  }

  const visibleDomRenderedAttributes = [
    'id',
    'class',
    'aria-disabled',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-controls',
    'aria-expanded',
    'aria-pressed',
    'alt',
    'contenteditable',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'data-action',
    'data-click',
    'data-href',
    'data-url',
    'data-target',
    'href',
    'jsaction',
    'name',
    'ng-click',
    'onclick',
    'placeholder',
    'role',
    'tabindex',
    'title',
    'type',
    'value',
    'v-on:click',
    '@click',
  ];
  const visibleDomMeaningfulAttributes = visibleDomRenderedAttributes
    .filter((name) => !['id', 'class', 'aria-describedby', 'aria-controls'].includes(name));
  const visibleDomBooleanAttributes = ['checked', 'disabled', 'multiple', 'readonly', 'required', 'selected'];
  const visibleDomSkippedTextTags = new Set(['noscript', 'script', 'style', 'template']);

  function visibleDomState() {
    if (!win.__browserUseVisibleDomState) {
      win.__browserUseVisibleDomState = {
        elementToRef: new WeakMap<Element, string>(),
        instanceId: Math.random().toString(36).slice(2),
        nextId: 1,
        refToElement: new Map<string, Element>(),
      };
    }
    return win.__browserUseVisibleDomState;
  }

  function visualViewportRect() {
    const viewport = window.visualViewport;
    return viewport
      ? {
        bottom: viewport.offsetTop + viewport.height,
        left: viewport.offsetLeft,
        right: viewport.offsetLeft + viewport.width,
        top: viewport.offsetTop,
      }
      : { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 };
  }

  function intersectClip(left: BrowserUseViewportClip, right: BrowserUseViewportClip) {
    const clip = {
      bottom: Math.min(left.bottom, right.bottom),
      left: Math.max(left.left, right.left),
      right: Math.min(left.right, right.right),
      top: Math.max(left.top, right.top),
    };
    return clip.right > clip.left && clip.bottom > clip.top ? clip : undefined;
  }

  function visibleDomElementName(element: Element) {
    return (element.localName || element.nodeName || '').toLowerCase();
  }

  function isVisibleDomHidden(element: Element) {
    const tag = visibleDomElementName(element);
    return element.hasAttribute('hidden')
      || (element as HTMLElement).inert
      || element.hasAttribute('inert')
      || (tag === 'input' && element.getAttribute('type') === 'hidden');
  }

  function visibleDomStyle(element: Element) {
    try {
      return window.getComputedStyle(element);
    } catch {
      return undefined;
    }
  }

  function isVisibleDomStyleHidden(element: Element) {
    const style = visibleDomStyle(element);
    if (!style) return true;
    return style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden'
      || Number(style.opacity || '1') <= 0.01;
  }

  function hasVisibleDomPointerEvents(element: Element) {
    return visibleDomStyle(element)?.pointerEvents !== 'none';
  }

  function isVisibleDomSubtreeHidden(element: Element) {
    let current: Element | undefined = element;
    for (let guard = 0; current && guard < 256; guard += 1) {
      if (
        !isTraversable(current)
        || isOverlay(current)
        || isVisibleDomHidden(current)
        || isVisibleDomStyleHidden(current)
      ) {
        return true;
      }
      current = flatParentElement(current);
    }
    return false;
  }

  const visibleDomClickEventPattern = /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/;
  const visibleDomHoverEventPattern = /^(mouseenter|mouseover|pointerenter|pointerover)$/;
  const visibleDomActionRolePattern = /^(button|checkbox|combobox|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|switch|tab|textbox|treeitem)$/;

  function hasVisibleDomOwnHoverAttribute(element: Element) {
    return element.hasAttribute('onmouseenter')
      || element.hasAttribute('onmouseover')
      || element.hasAttribute('onpointerenter')
      || element.hasAttribute('onpointerover');
  }

  function visibleDomHoverElements() {
    const selectors: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules || [])) {
        const selectorText = (rule as CSSStyleRule).selectorText;
        if (!selectorText || !selectorText.includes(':hover')) continue;
        for (const part of selectorText.split(',')) {
          const normalized = part
            .replace(/:hover\b/g, '')
            .replace(/:(active|focus|focus-visible|focus-within|visited|link)\b/g, '')
            .trim();
          if (normalized && !/[>+~]\s*$/.test(normalized)) selectors.push(normalized);
        }
      }
    }
    const matches = new Set<Element>();
    for (const selector of Array.from(new Set(selectors)).slice(0, 600)) {
      try {
        for (const element of Array.from(document.querySelectorAll(selector))) matches.add(element);
      } catch {
        // Ignore selectors that cannot be queried outside their rule context.
      }
    }
    return matches;
  }

  function visibleDomInteractionSignals(element: Element, hoverElements: Set<Element> = new Set()) {
    const signals: string[] = [];
    const tag = visibleDomElementName(element);
    if (hasNativeActionSignal(element, tag)) signals.push('native');
    if (element.hasAttribute('onclick')) signals.push('onclick');
    const role = normalizeVisibleDomText(element.getAttribute('role') || '').toLowerCase();
    if (visibleDomActionRolePattern.test(role)) signals.push(`role:${role}`);
    for (const type of recordedEventTypes(element)) {
      if (visibleDomClickEventPattern.test(type) || visibleDomHoverEventPattern.test(type)) signals.push(`listener:${type}`);
    }
    if (hasActionAttribute(element)) signals.push('action-attr');
    if (hasPointerCursor(element)) signals.push('cursor=pointer');
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') signals.push('tabindex');
    if (isContentEditableOwner(element)) signals.push('contenteditable');
    if (hasVisibleDomOwnHoverAttribute(element)) signals.push('hover-attribute');
    const shouldInspectCssHover = signals.some((signal) => !/^listener:(mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/.test(signal));
    const className = typeof element.className === 'string' ? element.className : '';
    if (shouldInspectCssHover && (hoverElements.has(element) || /(^|\s)hover[:_-]/.test(className))) signals.push('hover-css');
    const style = window.getComputedStyle(element);
    if (/^(auto|scroll)$/.test(style.overflowY)
      && element.children.length >= 3
      && (element as HTMLElement).clientHeight > 0
      && (element as HTMLElement).scrollHeight > (element as HTMLElement).clientHeight * 1.5) signals.push('virtual-list');
    return Array.from(new Set(signals));
  }

  function hasVisibleDomOwnClickBoundary(element: Element) {
    const role = normalizeVisibleDomText(element.getAttribute('role') || '').toLowerCase();
    return hasNativeActionSignal(element)
      || element.hasAttribute('onclick')
      || hasActionAttribute(element)
      || visibleDomActionRolePattern.test(role)
      || recordedEventTypes(element).some((type) => visibleDomClickEventPattern.test(type))
      || (element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1');
  }

  function visibleDomSvgActionScope(element: Element) {
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg') return '';
    if (visibleDomElementName(element) !== 'svg') return hasVisibleDomOwnClickBoundary(element) ? 'own' : 'graphic';
    const stack = Array.from(element.children).reverse();
    let visited = 0;
    while (stack.length && visited < 256) {
      const current = stack.pop()!;
      visited += 1;
      if (hasVisibleDomOwnClickBoundary(current)) return 'container';
      for (const child of Array.from(current.children).reverse()) stack.push(child);
    }
    return 'own';
  }

  function visibleDomActionCapabilities(element: Element, signals: string[]) {
    const capabilities = new Set<DomActionCapability>();
    const tag = visibleDomElementName(element);
    const type = normalizeVisibleDomText(element.getAttribute('type') || '').toLowerCase();
    const role = normalizeVisibleDomText(element.getAttribute('role') || '').toLowerCase();
    if (tag === 'input') {
      if (/^(button|checkbox|color|file|image|radio|range|reset|submit)$/i.test(type)) capabilities.add('click');
      else capabilities.add('fill');
      capabilities.add('focus');
    } else if (tag === 'textarea') {
      capabilities.add('fill');
      capabilities.add('focus');
    } else if (tag === 'select' || tag === 'option') {
      capabilities.add('select');
      capabilities.add('focus');
    } else if (['a', 'button', 'details', 'label', 'summary'].includes(tag)) {
      capabilities.add('click');
    }
    if (isContentEditableOwner(element) || role === 'textbox') {
      capabilities.add('fill');
      capabilities.add('focus');
    }
    if (visibleDomActionRolePattern.test(role) && role !== 'textbox' && role !== 'combobox') capabilities.add('click');
    if (role === 'combobox') {
      capabilities.add('select');
      capabilities.add('focus');
    }
    if (signals.some((signal) => /^(onclick|action-attr|listener:(click|dblclick|mouseup|pointerup))$/.test(signal))) capabilities.add('click');
    if (signals.includes('cursor=pointer')) capabilities.add('click');
    if (signals.includes('tabindex')) capabilities.add('focus');
    if (signals.some((signal) => /^(hover-attribute|hover-css|listener:(mouseenter|mouseover|pointerenter|pointerover))$/.test(signal))) capabilities.add('hover');
    if (signals.includes('virtual-list')) capabilities.add('scroll');
    const dragSignal = signals.some((signal) => /^listener:(mousedown|pointerdown|touchstart)$/.test(signal));
    if (dragSignal && (
      element.getAttribute('draggable') === 'true'
      || element.hasAttribute('cdkdraghandle')
      || element.hasAttribute('data-drag-handle')
    )) capabilities.add('drag');
    return Array.from(capabilities);
  }

  function visibleDomActionConfidence(element: Element, signals: string[], capabilities: DomActionCapability[]): DomActionConfidence {
    if (signals.some((signal) => /^(native|onclick|action-attr|role:|listener:(click|dblclick))/.test(signal))) return 'high';
    if (signals.includes('cursor=pointer') || signals.includes('contenteditable')) return 'medium';
    if (capabilities.includes('fill') || capabilities.includes('select')) return 'high';
    if (signals.some((signal) => /^(tabindex|hover-attribute|listener:(mouseenter|pointerenter))$/.test(signal))) return 'medium';
    if (signals.includes('virtual-list')) return 'medium';
    if (element.getAttribute('draggable') === 'true' || element.hasAttribute('cdkdraghandle') || element.hasAttribute('data-drag-handle')) return 'medium';
    return 'low';
  }

  function visibleDomLocatorCandidates(element: Element) {
    const values: string[] = [];
    const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const addAttribute = (name: string, value?: string | null, prefix = '') => {
      const normalized = normalizeVisibleDomText(value || '');
      if (!normalized || normalized.length > 240) return;
      values.push(`${prefix}[${name}="${quote(normalized)}"]`);
    };
    const tag = visibleDomElementName(element);
    for (const name of ['data-testid', 'data-test', 'data-qa', 'data-cy']) addAttribute(name, element.getAttribute(name));
    const id = normalizeVisibleDomText(element.id || '');
    if (id && id.length <= 120) {
      try {
        values.push(`#${CSS.escape(id)}`);
      } catch {
        addAttribute('id', id);
      }
    }
    if (tag === 'a') addAttribute('href', element.getAttribute('href'), 'a');
    const role = element.getAttribute('role');
    const ariaLabel = element.getAttribute('aria-label');
    if (role && ariaLabel) values.push(`[role="${quote(role)}"][aria-label="${quote(ariaLabel)}"]`);
    const name = element.getAttribute('name');
    if (name) addAttribute('name', name, tag);
    return Array.from(new Set(values)).slice(0, 8);
  }

  function visibleDomRect(element: Element, viewportClip: BrowserUseViewportClip) {
    const style = window.getComputedStyle(element);
    if (
      style.visibility !== 'visible'
      || style.display === 'none'
      || style.pointerEvents === 'none'
      || Number(style.opacity) <= 0.01
    ) {
      return undefined;
    }
    for (const rect of Array.from(element.getClientRects())) {
      if (
        rect.width > 0
        && rect.height > 0
        && rect.right > viewportClip.left
        && rect.left < viewportClip.right
        && rect.bottom > viewportClip.top
        && rect.top < viewportClip.bottom
      ) {
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      }
    }
    return undefined;
  }

  function renderedDomRect(element: Element) {
    if (!isRenderable(element, { requirePointerEvents: true })) return undefined;
    for (const rect of Array.from(element.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) {
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      }
    }
    return undefined;
  }

  function visibleDomSamplePoints(rect: BrowserUseViewportClip) {
    const insetX = Math.min(10, Math.max(1, (rect.right - rect.left) / 4));
    const insetY = Math.min(10, Math.max(1, (rect.bottom - rect.top) / 4));
    return [
      [rect.left + (rect.right - rect.left) / 2, rect.top + (rect.bottom - rect.top) / 2],
      [rect.left + insetX, rect.top + (rect.bottom - rect.top) / 2],
      [rect.right - insetX, rect.top + (rect.bottom - rect.top) / 2],
      [rect.left + (rect.right - rect.left) / 2, rect.top + insetY],
      [rect.left + (rect.right - rect.left) / 2, rect.bottom - insetY],
      [rect.left + insetX, rect.top + insetY],
      [rect.right - insetX, rect.top + insetY],
      [rect.left + insetX, rect.bottom - insetY],
      [rect.right - insetX, rect.bottom - insetY],
    ];
  }

  function scrollState(element: Element) {
    const top = Math.round(element.scrollTop);
    const left = Math.round(element.scrollLeft);
    const height = Math.round(element.scrollHeight);
    const width = Math.round(element.scrollWidth);
    const clientHeight = Math.round(element.clientHeight);
    const clientWidth = Math.round(element.clientWidth);
    const maxTop = Math.max(0, height - clientHeight);
    const maxLeft = Math.max(0, width - clientWidth);
    const remainingUp = Math.max(0, top);
    const remainingDown = Math.max(0, maxTop - top);
    const remainingLeft = Math.max(0, left);
    const remainingRight = Math.max(0, maxLeft - left);
    return {
      top,
      left,
      height,
      width,
      clientHeight,
      clientWidth,
      maxTop,
      maxLeft,
      remainingUp,
      remainingDown,
      remainingLeft,
      remainingRight,
      atTop: remainingUp <= 1,
      atBottom: remainingDown <= 1,
      atLeft: remainingLeft <= 1,
      atRight: remainingRight <= 1,
      canScrollUp: remainingUp > 1,
      canScrollDown: remainingDown > 1,
      canScrollLeft: remainingLeft > 1,
      canScrollRight: remainingRight > 1,
    };
  }

  function visibleDomClickablePoint(element: Element, viewportClip: BrowserUseViewportClip) {
    const rect = visibleDomRect(element, viewportClip);
    if (!rect) return undefined;
    for (const [x, y] of visibleDomSamplePoints(rect)) {
      const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
      const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
      if (pointBelongsToElement(element, px, py, { requirePointerEvents: true })) return { x: px, y: py };
    }
    return undefined;
  }

  function normalizeVisibleDomText(value: string) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function escapeVisibleDomText(value: string) {
    return value
      .replace(/[\t\n\f\r]+/g, ' ')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function visibleDomAttributeValue(element: Element, name: string) {
    const value = element.getAttribute(name);
    if (value === null || value === '') return undefined;
    const normalized = normalizeVisibleDomText(value);
    if (!normalized) return undefined;
    if (name === 'class') {
      const classes = normalized.split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
      return classes || undefined;
    }
    if (name === 'href') return normalized.slice(0, 240);
    if (name === 'value') return normalized.slice(0, 180);
    return normalized.slice(0, 140);
  }

  function visibleDomTextContent(element: Element, maxChars = 160) {
    const parts: string[] = [];
    let chars = 0;
    const visit = (node: Node) => {
      if (chars >= maxChars) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = normalizeVisibleDomText(node.nodeValue || '');
        if (text) {
          parts.push(text);
          chars += text.length + 1;
        }
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (isVisibleDomSubtreeHidden(element) || visibleDomSkippedTextTags.has(visibleDomElementName(element))) return;
      }
      for (const child of Array.from(node.childNodes || [])) {
        if (chars >= maxChars) break;
        visit(child);
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (isVisibleDomSubtreeHidden(element)) return;
        const root = shadowRootOf(element);
        if (!root) return;
        for (const child of Array.from(root.childNodes)) {
          if (chars >= maxChars) break;
          visit(child);
        }
      }
    };
    visit(element);
    return normalizeVisibleDomText(parts.join(' ')).slice(0, maxChars);
  }

  function visibleDomOwnTextContent(element: Element) {
    const parts: string[] = [];
    let chars = 0;
    const visitTextChildren = (node: Node) => {
      for (const child of Array.from(node.childNodes || [])) {
        if (chars >= 160) break;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = normalizeVisibleDomText(child.nodeValue || '');
          if (text) {
            parts.push(text);
            chars += text.length + 1;
          }
        }
      }
    };
    visitTextChildren(element);
    const root = shadowRootOf(element);
    if (root) visitTextChildren(root);
    return normalizeVisibleDomText(parts.join(' ')).slice(0, 160);
  }

  function visibleDomUniqueText(values: string[]) {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
      const text = normalizeVisibleDomText(value);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      output.push(text);
    }
    return output;
  }

  const visibleDomLabelAttributeNames = ['aria-label', 'alt', 'placeholder', 'title', 'value'];
  const visibleDomDescendantSemanticAttributeNames = ['aria-label', 'title', 'alt', 'data-testid', 'data-test', 'data-qa', 'data-cy'];
  const visibleDomInteractiveStateAttributes = [
    'id',
    'class',
    'aria-disabled',
    'aria-label',
    'placeholder',
    'title',
    'role',
    'type',
    'name',
    'value',
    'href',
    'aria-expanded',
    'aria-pressed',
    'checked',
    'disabled',
    'readonly',
    'required',
    'selected',
    'contenteditable',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'data-action',
    'data-click',
    'data-href',
    'data-target',
    'data-url',
    'jsaction',
    'ng-click',
    'onclick',
    'tabindex',
    'v-on:click',
    '@click',
  ];

  function visibleDomDescendantSemanticText(element: Element) {
    const values: string[] = [];
    let chars = 0;
    const append = (value?: string | null) => {
      if (chars >= 160) return;
      const text = normalizeVisibleDomText(value || '');
      if (!text) return;
      values.push(text);
      chars += text.length + 1;
    };
    const visit = (node: Node, root = false) => {
      if (chars >= 160) return;
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const child = node as Element;
      if (!root && isVisibleDomSubtreeHidden(child)) return;
      if (!root) {
        for (const name of visibleDomDescendantSemanticAttributeNames) append(child.getAttribute(name));
      }
      const rootNode = shadowRootOf(child);
      for (const nested of Array.from(child.childNodes || [])) {
        if (chars >= 160) break;
        visit(nested, false);
      }
      if (rootNode) {
        for (const nested of Array.from(rootNode.childNodes || [])) {
          if (chars >= 160) break;
          visit(nested, false);
        }
      }
    };
    visit(element, true);
    return visibleDomUniqueText(values).join(' | ').slice(0, 160);
  }

  function visibleDomLineText(element: Element, interactive: boolean) {
    const text = visibleDomTextContent(element);
    if (text || !interactive) return text;
    return visibleDomDescendantSemanticText(element);
  }

  function visibleDomLabelForElement(element: Element, interactive: boolean, lineText: string) {
    const values = visibleDomUniqueText([
      lineText,
      ...visibleDomLabelAttributeNames.map((name) => visibleDomAttributeValue(element, name) || ''),
      visibleDomAttributeValue(element, 'name') || '',
    ]);
    if (values.length) return values.join(' | ').slice(0, 180);
    if (!interactive) return '';
    return 'icon-only/unlabeled interactive';
  }

  function visibleDomInteractiveStateForElement(element: Element, signals: string[]) {
    const values = visibleDomInteractiveStateAttributes
      .map((name) => {
        const value = visibleDomAttributeValue(element, name);
        return value ? `${name}=${JSON.stringify(value)}` : '';
      })
      .filter(Boolean);
    if (signals.length) values.push(`signals=${JSON.stringify(Array.from(new Set(signals)).join('|'))}`);
    return values.join(' ');
  }

  function renderedTextFromNode(rootNode: Node, maxChars: number) {
    const limit = Math.max(1, Math.floor(Number(maxChars) || 200000));
    const parts: string[] = [];
    let chars = 0;
    let textLength = 0;
    const textAttributes = ['alt', 'aria-label', 'placeholder', 'title'];
    const append = (value?: string | null) => {
      const text = normalizeVisibleDomText(value || '');
      if (!text) return;
      textLength += text.length + (textLength ? 1 : 0);
      if (chars >= limit) return;
      const remaining = limit - chars;
      const chunk = text.length > remaining ? text.slice(0, remaining) : text;
      if (chunk) {
        parts.push(chunk);
        chars += chunk.length + 1;
      }
    };
    const visit = (node: Node) => {
      if (chars >= limit) return;
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.nodeValue || '');
        return;
      }
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root);
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of Array.from(node.childNodes || [])) {
          if (chars >= limit) break;
          visit(child);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isVisibleDomSubtreeHidden(element)) return;
      const tag = visibleDomElementName(element);
      for (const name of textAttributes) append(element.getAttribute(name));
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const value = (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
        append(value);
      }
      for (const child of Array.from(element.childNodes || [])) {
        if (chars >= limit) break;
        visit(child);
      }
      const root = shadowRootOf(element);
      if (root) visit(root);
    };
    visit(rootNode);
    return {
      text: normalizeVisibleDomText(parts.join(' ')).slice(0, limit),
      textLength,
    };
  }

  function visibleDomRef(element: Element) {
    const state = visibleDomState();
    let ref = state.elementToRef.get(element);
    if (!ref) {
      ref = String(state.nextId++);
      state.elementToRef.set(element, ref);
    }
    return ref;
  }

  function visibleDomSelectOptions(element: HTMLSelectElement) {
    return Array.from(element.options).map((option) => {
      const label = normalizeVisibleDomText(option.label || option.text || option.textContent || '');
      const value = normalizeVisibleDomText(option.value || '');
      return `${option.selected ? '*' : ''}${value || '[empty]'}=${label || '[empty]'}`;
    }).join(' | ');
  }

  function visibleDomItem(element: Element, ref: string, signals: string[] = []) {
    const tag = visibleDomElementName(element);
    const attrs = [`node_id=${ref}`];
    const surfaceId = surfaceIdForElement(element);
    if (surfaceId) attrs.push(`surface="${escapeVisibleDomText(surfaceId)}"`);
    for (const name of visibleDomRenderedAttributes) {
      const value = visibleDomAttributeValue(element, name);
      if (value) attrs.push(`${name}="${escapeVisibleDomText(value)}"`);
    }
    for (const name of visibleDomBooleanAttributes) {
      if (element.hasAttribute(name)) attrs.push(`${name}="true"`);
    }
    if (signals.length) {
      attrs.push(`signals="${escapeVisibleDomText(Array.from(new Set(signals)).join('|'))}"`);
    }
    const svgActionScope = visibleDomSvgActionScope(element);
    if (svgActionScope) attrs.push(`action_scope="${svgActionScope}"`);
    if (tag === 'select') {
      const select = element as HTMLSelectElement;
      const selected = select.selectedOptions[0];
      const options = visibleDomSelectOptions(select);
      attrs.push(`option_count="${select.options.length}"`);
      if (selected) attrs.push(`selected_value="${escapeVisibleDomText(selected.value)}"`);
      if (options) attrs.push(`options="${escapeVisibleDomText(options)}"`);
    }
    if (signals.includes('virtual-list')) {
      const target = element as HTMLElement;
      const childHeights = Array.from(element.children).slice(0, 20)
        .map((child) => child.getBoundingClientRect().height)
        .filter((height) => height > 1)
        .sort((left, right) => left - right);
      const medianHeight = childHeights.length ? childHeights[Math.floor(childHeights.length / 2)] : 0;
      const estimatedItems = medianHeight > 0 ? Math.max(element.children.length, Math.round(target.scrollHeight / medianHeight)) : element.children.length;
      const firstVisibleIndex = medianHeight > 0 ? Math.max(0, Math.floor(target.scrollTop / medianHeight)) : 0;
      attrs.push('virtualized="possible"');
      attrs.push('actions="scroll,search"');
      attrs.push(`visible_children="${element.children.length}"`);
      attrs.push(`estimated_items="${estimatedItems}"`);
      attrs.push(`visible_range="${firstVisibleIndex + 1}-${Math.min(estimatedItems, firstVisibleIndex + element.children.length)}"`);
      attrs.push(`scroll_top="${Math.round(target.scrollTop)}"`);
      attrs.push(`scroll_height="${Math.round(target.scrollHeight)}"`);
    }
    const capabilities = visibleDomActionCapabilities(element, signals);
    const confidence = visibleDomActionConfidence(element, signals, capabilities);
    const interactive = capabilities.length > 0;
    const text = visibleDomLineText(element, interactive);
    const ownText = visibleDomOwnTextContent(element);
    const semanticTextTags = new Set(['a', 'button', 'dd', 'dt', 'figcaption', 'label', 'legend', 'li', 'option', 'p', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const formText = ['input', 'select', 'textarea'].includes(tag)
      ? visibleDomUniqueText(['aria-label', 'placeholder', 'value', 'name'].map((name) => visibleDomAttributeValue(element, name) || '')).join(' | ')
      : '';
    const textEntry = ownText || formText || (semanticTextTags.has(tag) ? text : '');
    const contextText = tag === 'tr'
      ? visibleDomTextContent(element, 800)
      : ['article', 'dialog', 'fieldset', 'form', 'li', 'nav', 'section'].includes(tag)
        ? visibleDomTextContent(element, 320)
        : '';
    const rect = renderedDomRect(element);
    const viewport = visualViewportRect();
    const inModal = Boolean(element.closest('dialog[open], [aria-modal="true"]'));
    const containsFocus = element === document.activeElement || Boolean(element.contains(document.activeElement));
    const inViewport = Boolean(rect && rect.right > viewport.left && rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom);
    const priority = (inModal ? 60 : 0) + (containsFocus ? 35 : 0) + (inViewport ? 20 : 0) + (confidence === 'high' ? 10 : confidence === 'medium' ? 5 : 0);
    const line = text.length === 0
      ? `<${tag} ${attrs.join(' ')} />`
      : `<${tag} ${attrs.join(' ')}>${escapeVisibleDomText(text)}</${tag}>`;
    return {
      capabilities,
      confidence,
      contextText,
      interactive,
      label: visibleDomLabelForElement(element, interactive, text),
      line,
      locatorCandidates: visibleDomLocatorCandidates(element),
      priority,
      rect,
      signals,
      state: interactive ? visibleDomInteractiveStateForElement(element, signals) : '',
      surfaceId,
      tag,
      text: textEntry,
    };
  }

  function isVisibleDomExtraElement(element: Element, signals: string[]) {
    if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
    // `added` and `updated` remain the actionable channel. Extra deliberately
    // carries only semantic context that is not an action candidate.
    if (signals.length) return false;
    const tag = visibleDomElementName(element);
    if (new Set(['dd', 'details', 'dt', 'figcaption', 'label', 'legend', 'li', 'option', 'p', 'td', 'textarea', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']).has(tag)
      && visibleDomTextContent(element)) return true;
    if (new Set(['article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'main', 'nav', 'section', 'span']).has(tag)
      && visibleDomOwnTextContent(element)) return true;
    return visibleDomMeaningfulAttributes.some((name) => Boolean(visibleDomAttributeValue(element, name)));
  }

  function createVisibleDomSnapshotCollector(input: {
    state: ReturnType<typeof visibleDomState>;
    maxElements: number;
    maxChars: number;
    rectForFrame: (element: Element) => (BrowserUseViewportClip & { height: number; width: number }) | undefined;
  }) {
    const frameElements: BrowserUseVisibleDomSnapshot['frameElements'] = [];
    const items: BrowserUseVisibleDomSnapshot['items'] = [];
    let chars = 0;
    let truncated = false;
    const stop = () => truncated || items.length >= input.maxElements || chars >= input.maxChars;
    const pushItem = (element: Element, path: string, signals: string[] = []) => {
      if (stop()) return;
      const ref = visibleDomRef(element);
      const item = visibleDomItem(element, ref, signals);
      const lineChars = item.line.length + (items.length === 0 ? 0 : 1);
      if (chars + lineChars > input.maxChars) {
        truncated = true;
        return;
      }
      input.state.refToElement.set(ref, element);
      items.push({ ...item, descriptor: descriptor(element), path, ref });
      chars += lineChars;
    };
    const pushFrame = (element: Element) => {
      if (frameElements.length >= input.maxElements) return;
      const rect = input.rectForFrame(element);
      if (!rect) return;
      const ref = visibleDomRef(element);
      input.state.refToElement.set(ref, element);
      const frameElement = element as HTMLIFrameElement;
      frameElements.push({
        rect,
        ref,
        size: {
          height: Math.max(0, frameElement.clientHeight || rect.height),
          width: Math.max(0, frameElement.clientWidth || rect.width),
        },
        ...(frameElement.src ? { url: frameElement.src } : {}),
      });
    };
    return { frameElements, items, pushFrame, pushItem, stop };
  }

  function visitVisibleDom(input: {
    stop: () => boolean;
    onFrame: (element: Element) => void;
    onElement: (element: Element, path: string) => void;
  }) {
    const visit = (node: Node, path = '0') => {
      if (input.stop()) return;
      if (node.nodeType === Node.DOCUMENT_NODE) {
        const root = document.documentElement;
        if (root) visit(root, '0');
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const [index, child] of Array.from((node as DocumentFragment).children).entries()) {
          if (input.stop()) break;
          visit(child, `${path}.${index}`);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isDisplayNone(element)) return;
      const tag = visibleDomElementName(element);
      if (tag === 'frame' || tag === 'iframe') input.onFrame(element);
      input.onElement(element, path);
      for (const [index, child] of children(element).entries()) {
        if (input.stop()) break;
        visit(child, `${path}.${index}`);
      }
    };
    visit(document);
  }

  function visibleDomSnapshot(options: { maxChars: number; maxElements: number; preserveExistingRefs?: boolean; viewportClip?: BrowserUseViewportClip }) {
    const state = visibleDomState();
    if (!options.preserveExistingRefs) state.refToElement.clear();

    const rawViewport = visualViewportRect();
    const viewportClip = options.viewportClip ? intersectClip(rawViewport, options.viewportClip) || rawViewport : rawViewport;
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || 200));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 20000));
    const hoverElements = visibleDomHoverElements();
    const { frameElements, items, pushFrame, pushItem, stop } = createVisibleDomSnapshotCollector({
      state,
      maxElements,
      maxChars,
      rectForFrame: (element) => {
        const rect = visibleDomRect(element, viewportClip);
        return rect ? {
          ...rect,
          height: Math.max(0, rect.bottom - rect.top),
          width: Math.max(0, rect.right - rect.left),
        } : undefined;
      },
    });
    visitVisibleDom({
      stop,
      onFrame: pushFrame,
      onElement: (element, path) => {
        const signals = visibleDomInteractionSignals(element, hoverElements);
        if (
          signals.length
          && !isVisibleDomSubtreeHidden(element)
          && hasVisibleDomPointerEvents(element)
          && visibleDomClickablePoint(element, viewportClip)
        ) pushItem(element, path, signals);
      },
    });
    return { frameElements, items, stateKey: state.instanceId, viewport: rawViewport };
  }

  function fullDomSnapshot(options: { maxChars: number; maxElements: number; preserveExistingRefs?: boolean }) {
    const state = visibleDomState();
    if (!options.preserveExistingRefs) state.refToElement.clear();

    const viewport = visualViewportRect();
    const maxElements = Math.max(1, Math.floor(Number(options.maxElements) || 500));
    const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 60000));
    const hoverElements = visibleDomHoverElements();

    const structuralTextTags = new Set([
      'a', 'button', 'dd', 'details', 'dt', 'figcaption', 'input', 'label', 'legend', 'li',
      'option', 'p', 'select', 'summary', 'td', 'textarea', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);
    const directTextContainerTags = new Set(['article', 'aside', 'div', 'fieldset', 'footer', 'form', 'header', 'main', 'nav', 'section', 'span']);
    const signalCache = new WeakMap<Element, string[]>();
    const hasMeaningfulAttributes = (element: Element) => visibleDomMeaningfulAttributes.some((name) => Boolean(visibleDomAttributeValue(element, name)));
    const actionableSignals = (element: Element) => {
      const cached = signalCache.get(element);
      if (cached) return cached;
      const signals = visibleDomInteractionSignals(element, hoverElements);
      const actionable = signals.length && renderedDomRect(element) ? signals : [];
      signalCache.set(element, actionable);
      return actionable;
    };
    const shouldIncludeElement = (element: Element) => {
      if (isVisibleDomSubtreeHidden(element) || !hasVisibleDomPointerEvents(element)) return false;
      const tag = visibleDomElementName(element);
      if (actionableSignals(element).length) return true;
      if (structuralTextTags.has(tag) && visibleDomTextContent(element)) return true;
      if (directTextContainerTags.has(tag) && visibleDomOwnTextContent(element)) return true;
      return hasMeaningfulAttributes(element);
    };
    const { frameElements, items, pushFrame, pushItem, stop } = createVisibleDomSnapshotCollector({
      state,
      maxElements,
      maxChars,
      rectForFrame: (element) => {
        const box = elementBox(element);
        return box?.visible || (box?.raw
          ? { bottom: box.raw.bottom, height: box.raw.height, left: box.raw.left, right: box.raw.right, top: box.raw.top, width: box.raw.width }
          : undefined);
      },
    });
    visitVisibleDom({
      stop,
      onFrame: pushFrame,
      onElement: (element, path) => {
        if (shouldIncludeElement(element)) pushItem(element, path, actionableSignals(element));
      },
    });
    return { frameElements, items, stateKey: state.instanceId, viewport };
  }

  function discardDomChanges() {
    const discardedMutations = mutationState.pendingMutations?.length || 0;
    const overflow = Boolean(mutationState.pendingOverflow);
    mutationState.pendingMutations = [];
    mutationState.pendingMutationKeys = new WeakMap<Node, Set<string>>();
    mutationState.pendingOverflow = false;
    return { epoch: mutationState.epoch, overflow, discardedMutations };
  }

  function discardDomJournal() {
    const discardedMutations = mutationState.journalMutations?.length || 0;
    const overflow = Boolean(mutationState.journalOverflow);
    mutationState.journalMutations = [];
    mutationState.journalOverflow = false;
    return { epoch: mutationState.epoch, overflow, discardedMutations };
  }

  function journalDomLine(element: Element) {
    const tag = visibleDomElementName(element) || 'element';
    const attrs = ['extra=true'];
    for (const name of visibleDomRenderedAttributes) {
      const value = visibleDomAttributeValue(element, name);
      if (value) attrs.push(`${name}="${escapeVisibleDomText(value)}"`);
    }
    for (const name of visibleDomBooleanAttributes) {
      if (element.hasAttribute(name)) attrs.push(`${name}="true"`);
    }
    const text = visibleDomTextContent(element, 400);
    return `<${tag} ${attrs.join(' ')}>${text ? ` ${escapeVisibleDomText(text)}` : ''}`;
  }

  function journalDomDelta(): BrowserUseDomJournalDelta {
    const pending = [...(mutationState.journalMutations || [])];
    const overflow = Boolean(mutationState.journalOverflow);
    mutationState.journalMutations = [];
    mutationState.journalOverflow = false;
    const added = new Set<string>();
    const updated = new Set<string>();
    const removed = new Set<string>();
    let remainingNodes = 10000;
    const asElement = (node: Node | null | undefined) => {
      if (!node) return undefined;
      if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
      return flatParentElement(node);
    };
    const collect = (node: Node, destination: Set<string>) => {
      const root = asElement(node);
      if (!root) return;
      const stack = [root];
      while (stack.length && remainingNodes > 0) {
        const element = stack.pop()!;
        remainingNodes -= 1;
        if (isOverlay(element)) continue;
        destination.add(journalDomLine(element));
        const rootNode = shadowRootOf(element);
        if (rootNode) for (const child of Array.from(rootNode.children).reverse()) stack.push(child);
        for (const child of Array.from(element.children).reverse()) stack.push(child);
      }
    };
    for (const mutation of pending) {
      if (mutation.type === 'childList') {
        for (const node of Array.from(mutation.addedNodes)) collect(node, added);
        for (const node of Array.from(mutation.removedNodes)) collect(node, removed);
        const target = asElement(mutation.target);
        if (target && !isOverlay(target)) updated.add(journalDomLine(target));
      } else {
        const target = asElement(mutation.target);
        if (target && !isOverlay(target)) updated.add(journalDomLine(target));
      }
    }
    return {
      epoch: mutationState.epoch,
      stateKey: visibleDomState().instanceId,
      added: [...added],
      updated: [...updated],
      removed: [...removed],
      overflow: overflow || remainingNodes <= 0,
    };
  }

  function visibleDomDelta(): BrowserUseDomDelta {
    const state = visibleDomState();
    const pending = [...(mutationState.pendingMutations || [])];
    const overflow = Boolean(mutationState.pendingOverflow);
    mutationState.pendingMutations = [];
    mutationState.pendingMutationKeys = new WeakMap<Node, Set<string>>();
    mutationState.pendingOverflow = false;
    if (!pending.length) {
      return {
        epoch: mutationState.epoch,
        stateKey: state.instanceId,
        observation: pageObservation(),
        added: [],
        updated: [],
        extra: { added: [], updated: [] },
        removedRefs: [],
        overflow,
      };
    }
    const addedRoots = new Set<Element>();
    const updatedRoots = new Set<Element>();
    const removedRefs = new Set<string>();
    const maxNodes = 10000;
    let remainingNodes = maxNodes;
    let remainingRemovedNodes = maxNodes;
    const hoverElements = visibleDomHoverElements();

    const asElement = (node: Node | null | undefined) => {
      if (!node) return undefined;
      if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
      return flatParentElement(node);
    };
    const semanticMutationRoot = (element: Element | undefined) => {
      let current = element;
      for (let guard = 0; current && guard < 128; guard += 1) {
        const ref = state.elementToRef.get(current);
        const broadDocumentContainer = current === document.body || current === document.documentElement;
        if ((ref && state.refToElement.has(ref)) || (!broadDocumentContainer && isActionable(current))) return current;
        current = flatParentElement(current);
      }
      return element;
    };
    const rememberRemoved = (node: Node) => {
      const stack: Node[] = [node];
      while (stack.length && remainingRemovedNodes > 0) {
        const current = stack.pop()!;
        remainingRemovedNodes -= 1;
        if (current.nodeType === Node.ELEMENT_NODE) {
          const element = current as Element;
          const ref = state.elementToRef.get(element);
          if (ref) removedRefs.add(ref);
          for (const child of Array.from(element.children)) stack.push(child);
          const root = shadowRootOf(element);
          if (root) for (const child of Array.from(root.children)) stack.push(child);
        }
      }
    };

    for (const mutation of pending) {
      const target = asElement(mutation.target);
      if (mutation.type === 'childList') {
        // The inserted subtree supplies new UIDs. Only update a small tracked
        // container itself; never rescan a broad parent such as <body>.
        const semanticTarget = semanticMutationRoot(target);
        if (semanticTarget && !isOverlay(semanticTarget) && semanticTarget.children.length <= 64) {
          updatedRoots.add(semanticTarget);
        }
        for (const node of Array.from(mutation.addedNodes)) {
          const element = asElement(node);
          if (element && !isOverlay(element)) addedRoots.add(element);
        }
        for (const node of Array.from(mutation.removedNodes)) rememberRemoved(node);
      } else if (target && !isOverlay(target)) {
        updatedRoots.add(semanticMutationRoot(target) || target);
      }
    }

    const addedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const updatedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const extraAddedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const extraUpdatedByRef = new Map<string, BrowserUseVisibleDomSnapshot['items'][number]>();
    const hasAncestorRoot = (element: Element, roots: Set<Element>) => {
      let parent = flatParentElement(element);
      for (let guard = 0; parent && guard < 128; guard += 1) {
        if (roots.has(parent)) return true;
        parent = flatParentElement(parent);
      }
      return false;
    };
    const inspect = (
      element: Element,
      destination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
      extraDestination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
    ) => {
      if (!element.isConnected || isOverlay(element) || isDisplayNone(element)) return;
      const signals = visibleDomInteractionSignals(element, hoverElements);
      if (signals.length && !isVisibleDomSubtreeHidden(element) && hasVisibleDomPointerEvents(element) && renderedDomRect(element)) {
        const ref = visibleDomRef(element);
        state.refToElement.set(ref, element);
        removedRefs.delete(ref);
        destination.set(ref, {
          ...visibleDomItem(element, ref, signals),
          descriptor: descriptor(element),
          path: pathOf(element) || '',
          ref,
        });
      } else if (isVisibleDomExtraElement(element, signals)) {
        const ref = visibleDomRef(element);
        extraDestination.set(ref, {
          ...visibleDomItem(element, ref, signals),
          descriptor: descriptor(element),
          path: pathOf(element) || '',
          ref,
        });
      } else {
        const ref = state.elementToRef.get(element);
        if (ref) removedRefs.add(ref);
      }
    };
    const collectSubtree = (
      root: Element,
      destination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
      extraDestination: Map<string, BrowserUseVisibleDomSnapshot['items'][number]>,
    ) => {
      const stack: Element[] = [root];
      while (stack.length && remainingNodes > 0) {
        const element = stack.pop()!;
        remainingNodes -= 1;
        inspect(element, destination, extraDestination);
        if (!element.isConnected || isOverlay(element) || isVisibleDomSubtreeHidden(element)) continue;
        const rootNode = shadowRootOf(element);
        if (rootNode) for (const child of Array.from(rootNode.children).reverse()) stack.push(child);
        for (const child of Array.from(element.children).reverse()) stack.push(child);
      }
    };

    for (const root of addedRoots) {
      if (!hasAncestorRoot(root, addedRoots)) collectSubtree(root, addedByRef, extraAddedByRef);
      if (remainingNodes <= 0) break;
    }
    for (const root of updatedRoots) {
      if (hasAncestorRoot(root, addedRoots) || hasAncestorRoot(root, updatedRoots)) continue;
      if (remainingNodes <= 0) break;
      remainingNodes -= 1;
      inspect(root, updatedByRef, extraUpdatedByRef);
    }
    for (const ref of addedByRef.keys()) removedRefs.delete(ref);
    for (const ref of removedRefs) state.refToElement.delete(ref);
    return {
      epoch: mutationState.epoch,
      stateKey: state.instanceId,
      observation: pageObservation(),
      added: [...addedByRef.values()],
      updated: [...updatedByRef.values()].filter((item) => !addedByRef.has(item.ref)),
      extra: {
        added: [...extraAddedByRef.values()],
        updated: [...extraUpdatedByRef.values()].filter((item) => !extraAddedByRef.has(item.ref)),
      },
      removedRefs: [...removedRefs],
      overflow,
    };
  }

  function visibleDomCoveredPoint(element: Element, viewportClip: BrowserUseViewportClip) {
    const rect = visibleDomRect(element, viewportClip);
    if (!rect) return undefined;
    let firstCovered: { x: number; y: number; coveredBy: string } | undefined;
    for (const [rawX, rawY] of visibleDomSamplePoints(rect)) {
      const x = Math.min(Math.max(rawX, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rawY, 0), window.innerHeight - 1);
      const cover = topmostRenderableAt(x, y, { requirePointerEvents: true });
      if (!cover || cover === element || composedContains(element, cover)) continue;
      const candidate = {
        x,
        y,
        coveredBy: descriptor(cover),
      };
      firstCovered ||= candidate;
    }
    return firstCovered;
  }

  function visibleDomPoint(ref: string, viewportClip?: BrowserUseViewportClip) {
    const element = visibleDomState().refToElement.get(ref);
    if (!element?.isConnected) return undefined;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const clip = viewportClip || visualViewportRect();
    const clickablePoint = visibleDomClickablePoint(element, clip);
    if (clickablePoint) return { ...clickablePoint, descriptor: descriptor(element) };
    const coveredPoint = visibleDomCoveredPoint(element, clip);
    if (coveredPoint) return { ...coveredPoint, descriptor: descriptor(element) };
    const pointInRect = (rect: DOMRect | ClientRect) => {
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      const left = Math.max(rect.left, clip.left);
      const right = Math.min(rect.right, clip.right);
      const top = Math.max(rect.top, clip.top);
      const bottom = Math.min(rect.bottom, clip.bottom);
      return right > left && bottom > top
        ? { x: left + (right - left) / 2, y: top + (bottom - top) / 2 }
        : undefined;
    };
    for (const rect of Array.from(element.getClientRects())) {
      const point = pointInRect(rect);
      if (point) return { ...point, descriptor: descriptor(element) };
    }
    const point = pointInRect(element.getBoundingClientRect());
    return point ? { ...point, descriptor: descriptor(element) } : undefined;
  }

  function visibleDomElement(ref: string) {
    const element = visibleDomState().refToElement.get(ref);
    if (!element?.isConnected) return undefined;
    return actionableTargetFor(element);
  }

  function scrollVisibleDomVirtualList(ref: string, input: { advance?: boolean; top?: number } = {}) {
    const element = visibleDomState().refToElement.get(ref) as HTMLElement | undefined;
    if (!element?.isConnected || element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight) return undefined;
    const before = element.scrollTop;
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const requested = input.advance === false
      ? before
      : Number.isFinite(input.top)
      ? Number(input.top)
      : before + Math.max(1, Math.round(element.clientHeight * 0.85));
    element.scrollTop = Math.max(0, Math.min(maxTop, requested));
    const after = element.scrollTop;
    return { after, atBottom: after >= maxTop - 1, before, maxTop, moved: Math.abs(after - before) >= 1 };
  }

  async function findVisibleDomVirtualOption(ref: string, input: { value?: string; label?: string }) {
    const state = visibleDomState();
    const container = state.refToElement.get(ref) as HTMLElement | undefined;
    if (!container?.isConnected) {
      return { ok: false, actual: 'The virtual-list container is no longer connected.' };
    }
    if (container.clientHeight <= 0 || container.scrollHeight <= container.clientHeight) {
      return { ok: false, actual: 'The target is not a scrollable virtual-list container.' };
    }
    const expectedValue = normalizeVisibleDomText(input.value || '');
    const expectedLabel = normalizeVisibleDomText(input.label || '');
    if (!expectedValue && !expectedLabel) {
      return { ok: false, actual: 'Virtual-list selection requires an exact value or full label.' };
    }

    const optionValues = (element: Element) => visibleDomUniqueText([
      element.getAttribute('value') || '',
      element.getAttribute('data-value') || '',
      element.getAttribute('data-key') || '',
      element.getAttribute('data-id') || '',
    ].map(normalizeVisibleDomText));
    const optionLabels = (element: Element) => visibleDomUniqueText([
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      visibleDomTextContent(element, 1000),
    ].map(normalizeVisibleDomText));
    const exactMatch = (element: Element) => expectedValue
      ? optionValues(element).includes(expectedValue)
      : optionLabels(element).includes(expectedLabel);
    let lastCandidateLabels: string[] = [];
    const currentMatches = () => {
      const matches: Array<{ element: Element; signals: string[] }> = [];
      const seen = new Set<Element>();
      const candidateLabels: string[] = [];
      const stack = children(container).reverse();
      while (stack.length) {
        const element = stack.pop()!;
        if (!element.isConnected || isVisibleDomSubtreeHidden(element)) continue;
        const actionTarget = actionableTargetFor(element);
        if (actionTarget !== container && !seen.has(actionTarget)) {
          const signals = visibleDomInteractionSignals(actionTarget);
          const capabilities = visibleDomActionCapabilities(actionTarget, signals);
          if (capabilities.includes('click') && renderedDomRect(actionTarget)) {
            candidateLabels.push(...optionLabels(actionTarget));
            if (exactMatch(actionTarget)) {
              seen.add(actionTarget);
              matches.push({ element: actionTarget, signals });
            }
          }
        }
        const root = shadowRootOf(element);
        if (root) stack.push(...Array.from(root.children).reverse());
        stack.push(...Array.from(element.children).reverse());
      }
      lastCandidateLabels = visibleDomUniqueText(candidateLabels).slice(0, 12);
      return matches;
    };
    const settle = () => new Promise<void>((resolve) => {
      window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 40);
    });
    const originalTop = container.scrollTop;
    const originalOverflowAnchor = container.style.overflowAnchor;
    const originalScrollBehavior = container.style.scrollBehavior;
    // Recycling rows changes spacer heights. Disable scroll anchoring while scanning so
    // Chromium does not compensate for those mutations and silently skip ranges.
    container.style.overflowAnchor = 'none';
    container.style.scrollBehavior = 'auto';
    const deadline = performance.now() + 6000;
    let scanSteps = 0;

    try {
      while (performance.now() < deadline && scanSteps < 500) {
        scanSteps += 1;
        const matches = currentMatches();
        if (matches.length > 1) {
          container.scrollTop = originalTop;
          container.dispatchEvent(new Event('scroll'));
          await settle();
          return {
            ok: false,
            actual: `Virtual-list option is ambiguous: ${matches.length} mounted elements match the exact ${expectedValue ? 'value' : 'label'}.`,
          };
        }
        if (matches.length === 1) {
          matches[0].element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          await settle();
          const settledMatches = currentMatches();
          if (settledMatches.length === 1) {
            const target = settledMatches[0].element;
            const point = visibleDomClickablePoint(target, visualViewportRect());
            if (!point) {
              return {
                ok: false,
                actual: 'The exact virtual-list option is mounted but has no uncovered viewport click point.',
              };
            }
            const targetRef = visibleDomRef(target);
            state.refToElement.set(targetRef, target);
            const value = optionValues(target)[0] || '';
            const label = optionLabels(target)[0] || '';
            return {
              ok: true,
              actual: `Found one exact virtual-list option for ${expectedValue ? `value "${expectedValue}"` : `label "${expectedLabel}"`}.`,
              value,
              label,
              point,
              item: {
                ...visibleDomItem(target, targetRef, settledMatches[0].signals),
                descriptor: descriptor(target),
                path: pathOf(target) || '',
                ref: targetRef,
              },
            };
          }
        }

        const before = Math.round(container.scrollTop);
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (before >= maxTop - 1) break;
        const next = Math.min(maxTop, before + Math.max(1, Math.round(container.clientHeight * 0.5)));
        if (next <= before) break;
        container.scrollTop = next;
        container.dispatchEvent(new Event('scroll'));
        await settle();
      }

      const finalScanTop = Math.round(container.scrollTop);
      container.scrollTop = originalTop;
      container.dispatchEvent(new Event('scroll'));
      await settle();
      return {
        ok: false,
        actual: `No virtual-list option matched the exact ${expectedValue ? `value "${expectedValue}"` : `label "${expectedLabel}"`} within the bounded scan (${scanSteps} steps; final scrollTop=${finalScanTop}; last mounted labels=${lastCandidateLabels.join(' | ') || '[none]'}).`,
      };
    } finally {
      container.style.overflowAnchor = originalOverflowAnchor;
      container.style.scrollBehavior = originalScrollBehavior;
    }
  }

  function textResultForElement(element: Element, maxChars = 200000) {
    const result = renderedTextFromNode(element, maxChars);
    return {
      descriptor: descriptor(element),
      text: result.text,
      textLength: result.textLength,
    };
  }

  function elementText(pathValue: string, options: { maxChars?: number } = {}) {
    const element = elementFromPath(pathValue);
    return element ? textResultForElement(element, options.maxChars) : undefined;
  }

  function visibleDomText(ref: string, options: { maxChars?: number } = {}) {
    const element = visibleDomState().refToElement.get(ref);
    return element?.isConnected ? textResultForElement(element, options.maxChars) : undefined;
  }

  let cachedSurfaceEpoch = -1;
  let cachedSurfaceFocus: Element | null = null;
  let surfaceActivationSequence = 0;
  let previousVisibleSurfaceElements = new Set<Element>();
  let surfaceBaselineEstablished = false;
  const recognizedDynamicOverlayElements = new WeakSet<Element>();
  let pendingSurfaceParent: { element: Element; at: number } | undefined;
  const surfaceActivationOrder = new WeakMap<Element, number>();
  const inferredSurfaceParents = new WeakMap<Element, Element>();
  let cachedSurfaceState: {
    activeEntry?: { element: Element; order: number; score: number; surface: BrowserActiveSurface };
    entries: Array<{ element: Element; order: number; score: number; surface: BrowserActiveSurface }>;
    focused?: Element;
    scopeEntries: Array<{ element: Element; order: number; score: number; surface: BrowserActiveSurface }>;
    surfaceStack: BrowserActiveSurface[];
  } | undefined;

  function resolveSurfaceState() {
    const focused = document.activeElement instanceof Element && document.activeElement !== document.body
      ? document.activeElement
      : undefined;
    if (
      cachedSurfaceState
      && cachedSurfaceEpoch === mutationState.epoch
      && cachedSurfaceFocus === (focused || null)
    ) return cachedSurfaceState;
    const candidates = new Set<Element>();
    const controlledCandidates = new Set<Element>();
    const interactiveSurfaceCandidates = new Set<Element>();
    const surfaceControllers = new Map<Element, Element[]>();
    const explicitSurfaceSelector = [
      'dialog[open]',
      '[aria-modal="true"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="tree"]',
      '[role="grid"]',
    ].join(',');
    for (const element of Array.from(document.querySelectorAll(explicitSurfaceSelector))) candidates.add(element);
    try {
      for (const element of Array.from(document.querySelectorAll(':popover-open'))) candidates.add(element);
    } catch {
      // Older Chromium builds may not support :popover-open.
    }
    for (const controller of Array.from(document.querySelectorAll('[aria-expanded="true"][aria-controls]'))) {
      for (const id of normalize(controller.getAttribute('aria-controls')).split(/\s+/).filter(Boolean)) {
        const controlled = document.getElementById(id);
        if (!controlled) continue;
        candidates.add(controlled);
        controlledCandidates.add(controlled);
        surfaceControllers.set(controlled, [...(surfaceControllers.get(controlled) || []), controller]);
      }
    }

    const interactiveSurfaceItemSelector = [
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="treeitem"]',
      'button',
      'input',
      'select',
      'textarea',
      'a[href]',
      '[tabindex]',
      '[contenteditable="true"]',
    ].join(',');
    for (const item of Array.from(document.querySelectorAll(interactiveSurfaceItemSelector))) {
      let current: Element | undefined = item;
      for (let guard = 0; current && guard < 16; guard += 1) {
        const style = visibleDomStyle(current);
        const zIndex = Number.parseInt(style?.zIndex || '', 10);
        if (
          style
          && ['absolute', 'fixed'].includes(style.position)
          && Number.isFinite(zIndex)
          && zIndex >= 500
        ) {
          candidates.add(current);
          interactiveSurfaceCandidates.add(current);
          break;
        }
        current = flatParentElement(current);
      }
    }

    const allElements = Array.from(document.body?.querySelectorAll('*') || []);
    const all = allElements.length <= 6000
      ? allElements
      : [...allElements.slice(0, 3000), ...allElements.slice(-3000)];
    for (const element of all) {
      if (isOverlay(element) || isVisibleDomSubtreeHidden(element)) continue;
      const style = visibleDomStyle(element);
      if (!style || !['absolute', 'fixed', 'sticky'].includes(style.position)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      const areaRatio = Math.min(1, Math.max(0, rect.width * rect.height / viewportArea));
      const zIndex = Number.parseInt(style.zIndex, 10);
      const focusedInside = Boolean(focused && composedContains(element, focused));
      const horizontalChrome = (
        (rect.top <= 2 || rect.bottom >= window.innerHeight - 2)
        && rect.width >= window.innerWidth * 0.72
        && rect.height <= window.innerHeight * 0.28
      );
      const verticalChrome = (
        (rect.left <= 2 || rect.right >= window.innerWidth - 2)
        && rect.height >= window.innerHeight * 0.72
        && rect.width <= window.innerWidth * 0.32
      );
      const peripheralChrome = (
        (rect.left <= window.innerWidth * 0.05 || rect.right >= window.innerWidth * 0.95)
        && rect.height >= window.innerHeight * 0.25
        && rect.width <= window.innerWidth * 0.32
      ) || (
        (rect.top <= window.innerHeight * 0.05 || rect.bottom >= window.innerHeight * 0.95)
        && rect.width >= window.innerWidth * 0.45
        && rect.height <= window.innerHeight * 0.28
      );
      const edgeChrome = horizontalChrome || verticalChrome || peripheralChrome;
      const backdropSized = areaRatio >= 0.35;
      if (
        (Number.isFinite(zIndex) && zIndex > 0 || focusedInside || areaRatio >= 0.03)
        && (!edgeChrome || backdropSized || focusedInside)
      ) {
        candidates.add(element);
      }
    }
    if (focused) {
      let current: Element | undefined = focused;
      for (let guard = 0; current && guard < 64; guard += 1) {
        const role = normalize(current.getAttribute('role')).toLowerCase();
        const style = visibleDomStyle(current);
        if (
          ['dialog', 'alertdialog', 'menu', 'listbox', 'tree', 'grid'].includes(role)
          || current instanceof HTMLDialogElement
          || style && ['absolute', 'fixed'].includes(style.position)
        ) {
          candidates.add(current);
        }
        current = flatParentElement(current);
      }
    }

    const scored = Array.from(candidates).flatMap((element, order) => {
      if (!element.isConnected || isOverlay(element) || isVisibleDomSubtreeHidden(element)) return [];
      const style = visibleDomStyle(element);
      if (!style || style.pointerEvents === 'none') return [];
      const rect = element.getBoundingClientRect();
      const role = normalize(element.getAttribute('role')).toLowerCase();
      const modal = element.getAttribute('aria-modal') === 'true'
        || element instanceof HTMLDialogElement && element.open;
      const popover = (() => {
        try {
          return element.matches(':popover-open');
        } catch {
          return false;
        }
      })();
      const semanticSurface = modal
        || popover
        || ['dialog', 'alertdialog', 'menu', 'listbox', 'tree'].includes(role);
      const clippedLeft = Math.max(0, rect.left);
      const clippedTop = Math.max(0, rect.top);
      const clippedRight = Math.min(window.innerWidth, rect.right);
      const clippedBottom = Math.min(window.innerHeight, rect.bottom);
      const clippedWidth = clippedRight - clippedLeft;
      const clippedHeight = clippedBottom - clippedTop;
      const useRawRect = semanticSurface && (clippedWidth <= 2 || clippedHeight <= 2);
      const left = useRawRect ? rect.left : clippedLeft;
      const top = useRawRect ? rect.top : clippedTop;
      const right = useRawRect ? rect.right : clippedRight;
      const bottom = useRawRect ? rect.bottom : clippedBottom;
      const width = right - left;
      const height = bottom - top;
      if (width <= 2 || height <= 2) return [];
      const controlled = controlledCandidates.has(element);
      const interactiveSurface = interactiveSurfaceCandidates.has(element);
      const focusedInside = Boolean(focused && composedContains(element, focused));
      const zIndex = Number.parseInt(style.zIndex, 10);
      const normalizedZIndex = Number.isFinite(zIndex) ? zIndex : 0;
      const zIndexOutlier = normalizedZIndex >= 500;
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      const areaRatio = Math.min(1, width * height / viewportArea);
      const surfaceRole = ['dialog', 'alertdialog', 'menu', 'listbox', 'tree'].includes(role);
      const positioned = ['absolute', 'fixed', 'sticky'].includes(style.position);
      const persistentLandmark = element.matches(
        'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [role="complementary"]',
      );
      if (
        persistentLandmark
        && !modal
        && !popover
        && !controlled
        && !surfaceRole
        && !focusedInside
      ) {
        return [];
      }
      if (
        positioned
        && !modal
        && !popover
        && !controlled
        && !surfaceRole
        && !focusedInside
        && !interactiveSurface
        && areaRatio < 0.015
      ) {
        return [];
      }
      const horizontalChrome = (
        (rect.top <= 2 || rect.bottom >= window.innerHeight - 2)
        && width >= window.innerWidth * 0.72
        && height <= window.innerHeight * 0.28
      );
      const verticalChrome = (
        (rect.left <= 2 || rect.right >= window.innerWidth - 2)
        && height >= window.innerHeight * 0.72
        && width <= window.innerWidth * 0.32
      );
      const peripheralChrome = (
        (rect.left <= window.innerWidth * 0.05 || rect.right >= window.innerWidth * 0.95)
        && height >= window.innerHeight * 0.25
        && width <= window.innerWidth * 0.32
      ) || (
        (rect.top <= window.innerHeight * 0.05 || rect.bottom >= window.innerHeight * 0.95)
        && width >= window.innerWidth * 0.45
        && height <= window.innerHeight * 0.28
      );
      const edgeChrome = horizontalChrome || verticalChrome || peripheralChrome;
      const backdropSized = areaRatio >= 0.35;
      if (!modal && !popover && !controlled && !surfaceRole && !positioned) return [];
      if (
        edgeChrome
        && !backdropSized
        && !modal
        && !popover
        && !controlled
        && !surfaceRole
        && !focusedInside
        && !interactiveSurface
      ) {
        return [];
      }
      if (
        role === 'grid'
        && !modal
        && !popover
        && !controlled
        && !focusedInside
        && !positioned
      ) {
        return [];
      }
      let score = 0;
      if (modal) score += 2000;
      if (popover) score += 1700;
      if (controlled) score += 1400;
      if (interactiveSurface) score += 900;
      if (role === 'dialog' || role === 'alertdialog') score += 1200;
      else if (['menu', 'listbox', 'tree'].includes(role)) score += 1000;
      else if (role === 'grid') score += 500;
      if (focusedInside) score += 450;
      if (style.position === 'fixed') score += 300;
      else if (style.position === 'absolute') score += 180;
      else if (style.position === 'sticky') score += 40;
      score += Math.min(300, Math.max(0, normalizedZIndex));
      score += Math.round(Math.min(0.5, areaRatio) * 200);
      const centerX = left + width / 2;
      const centerY = top + height / 2;
      const topAtCenter = topmostRenderableAt(centerX, centerY);
      const topAtCenterInside = Boolean(topAtCenter && (
        topAtCenter === element
        || composedContains(element, topAtCenter)
      ));
      if (topAtCenterInside) score += 120;
      const signals = [
        ...(modal ? ['modal'] : []),
        ...(popover ? ['popover'] : []),
        ...(controlled ? ['aria-controls'] : []),
        ...(interactiveSurface ? ['interactive-descendant'] : []),
        ...(focusedInside ? ['focus-inside'] : []),
        ...(positioned ? [`position:${style.position}`] : []),
        ...(normalizedZIndex ? [`z-index:${normalizedZIndex}`] : []),
        ...(zIndexOutlier ? ['z-index-outlier'] : []),
        ...(topAtCenterInside ? ['topmost'] : []),
      ];
      const label = normalize(
        element.getAttribute('aria-label')
        || element.getAttribute('title')
        || textOf(element, 160),
      );
      const kind: BrowserActiveSurface['kind'] = modal || role === 'dialog' || role === 'alertdialog'
        ? 'dialog'
        : popover
          ? 'popover'
          : role === 'menu'
            ? 'menu'
            : role === 'listbox'
              ? 'listbox'
              : controlled
                ? 'panel'
                : 'overlay';
      const likelyOverlay = modal
        || popover
        || (controlled && !edgeChrome)
        || (zIndexOutlier && topAtCenterInside && !edgeChrome);
      const id = `surface-${visibleDomState().instanceId}-${visibleDomRef(element)}`;
      const surface: BrowserActiveSurface = {
          id,
          descriptor: descriptor(element),
          kind,
          label,
          modal,
          likelyOverlay,
          focusedInside,
          zIndex: normalizedZIndex,
          rect: { bottom, height, left, right, top, width },
          signals,
          ...(element.id ? { selector: `#${CSS.escape(element.id)}` } : {}),
          depth: 0,
          activationOrder: 0,
        };
      return [{ element, score, order, surface }];
    }).sort((left, right) => right.score - left.score || right.order - left.order);
    const visibleSurfaceElements = new Set(scored.map((entry) => entry.element));
    const newlyVisibleEntries = surfaceBaselineEstablished
      ? scored.filter((entry) => !previousVisibleSurfaceElements.has(entry.element))
      : [];
    const newlyVisibleSurfaceElements = new Set(newlyVisibleEntries.map((entry) => entry.element));
    for (const entry of newlyVisibleEntries) {
      if (entry.surface.likelyOverlay) recognizedDynamicOverlayElements.add(entry.element);
    }
    for (const entry of scored) {
      let activationOrder = surfaceActivationOrder.get(entry.element);
      if (activationOrder === undefined) {
        activationOrder = ++surfaceActivationSequence;
        surfaceActivationOrder.set(entry.element, activationOrder);
      }
      entry.surface.activationOrder = activationOrder;
    }
    let consumedPendingParent = false;
    if (
      pendingSurfaceParent
      && performance.now() - pendingSurfaceParent.at <= 2500
      && visibleSurfaceElements.has(pendingSurfaceParent.element)
    ) {
      const pendingParentEntry = scored.find((entry) => entry.element === pendingSurfaceParent?.element);
      for (const entry of newlyVisibleEntries) {
        if (
          entry.element !== pendingSurfaceParent.element
          && entry.surface.likelyOverlay
          && entry.surface.kind !== 'overlay'
          && (
            entry.surface.modal && pendingParentEntry?.surface.modal
            || ['popover', 'menu', 'listbox'].includes(entry.surface.kind)
          )
        ) {
          inferredSurfaceParents.set(entry.element, pendingSurfaceParent.element);
          entry.surface.signals.push('source-surface');
          consumedPendingParent = true;
        }
      }
    }
    if (consumedPendingParent || pendingSurfaceParent && performance.now() - pendingSurfaceParent.at > 2500) {
      pendingSurfaceParent = undefined;
    }
    previousVisibleSurfaceElements = visibleSurfaceElements;
    surfaceBaselineEstablished = true;
    for (const entry of scored) {
      const controllers = surfaceControllers.get(entry.element) || [];
      const inferredParent = inferredSurfaceParents.get(entry.element);
      const parent = scored
        .filter((candidate) => candidate !== entry && composedContains(candidate.element, entry.element))
        .sort((left, right) => (
          left.surface.rect.width * left.surface.rect.height
          - right.surface.rect.width * right.surface.rect.height
        ))[0] || scored
        .filter((candidate) => candidate !== entry && controllers.some((controller) => composedContains(candidate.element, controller)))
        .sort((left, right) => right.score - left.score)[0]
        || scored.find((candidate) => candidate.element === inferredParent);
      if (parent) entry.surface.parentId = parent.surface.id;
    }
    const depthOf = (entry: typeof scored[number], seen = new Set<string>()): number => {
      if (!entry.surface.parentId || seen.has(entry.surface.id)) return 0;
      const parent = scored.find((candidate) => candidate.surface.id === entry.surface.parentId);
      if (!parent) return 0;
      seen.add(entry.surface.id);
      return 1 + depthOf(parent, seen);
    };
    for (const entry of scored) entry.surface.depth = depthOf(entry);
    const leafEntries = scored.filter((entry) => !scored.some((candidate) => candidate.surface.parentId === entry.surface.id));
    const likelyOverlayLeafEntries = leafEntries.filter((entry) => entry.surface.likelyOverlay);
    const strongOverlayLeafEntries = likelyOverlayLeafEntries.filter((entry) => (
      entry.surface.modal
      || entry.surface.kind !== 'overlay'
      || entry.surface.signals.includes('popover')
      || entry.surface.signals.includes('aria-controls')
      || entry.surface.signals.includes('focus-inside')
      || entry.surface.signals.includes('source-surface')
      || newlyVisibleSurfaceElements.has(entry.element)
      || recognizedDynamicOverlayElements.has(entry.element)
    ));
    const scopeEntries = strongOverlayLeafEntries;
    const activeCandidates = scopeEntries;
    const activeEntry = [...activeCandidates].sort((left, right) => (
      Number(right.surface.likelyOverlay) - Number(left.surface.likelyOverlay)
      || Number(right.surface.focusedInside) - Number(left.surface.focusedInside)
      || right.surface.activationOrder - left.surface.activationOrder
      || right.surface.depth - left.surface.depth
      || right.score - left.score
      || right.surface.zIndex - left.surface.zIndex
      || right.order - left.order
    ))[0];
    const surfaceStack: BrowserActiveSurface[] = [];
    let stackEntry: typeof scored[number] | undefined = activeEntry;
    const seenStackIds = new Set<string>();
    while (stackEntry && !seenStackIds.has(stackEntry.surface.id)) {
      seenStackIds.add(stackEntry.surface.id);
      surfaceStack.unshift(stackEntry.surface);
      stackEntry = stackEntry.surface.parentId
        ? scored.find((candidate) => candidate.surface.id === stackEntry!.surface.parentId)
        : undefined;
    }
    cachedSurfaceEpoch = mutationState.epoch;
    cachedSurfaceFocus = focused || null;
    cachedSurfaceState = { activeEntry, entries: scored, focused, scopeEntries, surfaceStack };
    return cachedSurfaceState;
  }

  function surfaceIdForElement(element: Element) {
    return resolveSurfaceState().entries
      .filter((entry) => composedContains(entry.element, element))
      .sort((left, right) => right.surface.depth - left.surface.depth || right.score - left.score)[0]
      ?.surface.id;
  }

  function pageObservation(): BrowserPageObservation {
    const { activeEntry, entries, focused, scopeEntries, surfaceStack } = resolveSurfaceState();
    const activeSurface = activeEntry?.surface;
    const topSurfaceIds = scopeEntries.map((entry) => entry.surface.id);
    const signature = !topSurfaceIds.length && !activeSurface
      ? ''
      : `${topSurfaceIds.join(',')}|${activeSurface
        ? `${activeSurface.id}:${Math.round(activeSurface.rect.left)}:${Math.round(activeSurface.rect.top)}:${Math.round(activeSurface.rect.width)}:${Math.round(activeSurface.rect.height)}`
        : ''}`;
    const previousSignature = mutationState.activeSurfaceSignature;
    const surfaceTransition: BrowserPageObservation['surfaceTransition'] = previousSignature === undefined
      ? 'initial'
      : previousSignature === signature
        ? 'unchanged'
        : !previousSignature && signature
          ? 'opened'
          : previousSignature && !signature
            ? 'closed'
            : 'changed';
    mutationState.activeSurfaceSignature = signature;
    const currentUrl = window.location.href;
    const observedUrl = currentUrl.length <= 2048
      ? currentUrl
      : `${currentUrl.slice(0, 2000)}...[truncated; length=${currentUrl.length}]`;
    return {
      epoch: mutationState.epoch,
      url: observedUrl,
      title: document.title,
      ...(focused ? {
        focusedElement: {
          descriptor: descriptor(focused),
          label: normalize(
            focused.getAttribute('aria-label')
            || focused.getAttribute('title')
            || focused.getAttribute('placeholder')
            || textOf(focused, 120),
          ),
        },
      } : {}),
      ...(activeSurface ? { activeSurface } : {}),
      surfaces: entries.map((entry) => entry.surface),
      surfaceStack,
      topSurfaceIds,
      surfaceTransition,
    };
  }

  function rememberSurfaceSource(element: Element) {
    const entry = resolveSurfaceState().entries
      .filter((candidate) => composedContains(candidate.element, element))
      .sort((left, right) => right.surface.depth - left.surface.depth || right.score - left.score)[0];
    if (!entry) return;
    surfaceActivationOrder.set(entry.element, ++surfaceActivationSequence);
    pendingSurfaceParent = { element: entry.element, at: performance.now() };
    cachedSurfaceEpoch = -1;
  }

  function actionability(element: Element, options: { action?: string } = {}) {
    const action = normalize(options.action).toLowerCase();
    const targetDescriptor = descriptor(element);
    if (!element?.isConnected) {
      return { ok: false, reason: 'target is detached from the current document', descriptor: targetDescriptor };
    }
    const fileInputAction = action === 'setinputfiles';
    const pointerAction = /^(click|dblclick|hover|tap|check|uncheck|setchecked|dragto|draganddrop)$/.test(action);
    const viewportBlockingLayer = (candidate: Element | undefined) => {
      if (!candidate || composedContains(candidate, element) || composedContains(element, candidate)) return undefined;
      const style = visibleDomStyle(candidate);
      if (!style || !['fixed', 'absolute', 'sticky'].includes(style.position)) return undefined;
      const rect = candidate.getBoundingClientRect();
      const horizontalCoverage = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
      const verticalCoverage = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
      if (
        horizontalCoverage < window.innerWidth * 0.8
        || verticalCoverage < window.innerHeight * 0.8
      ) return undefined;
      return candidate;
    };
    const surfaceFailureContext = (coveredBy?: Element) => {
      const activeSurfaceId = resolveSurfaceState().activeEntry?.surface.id;
      const coveredBySurfaceId = coveredBy ? surfaceIdForElement(coveredBy) : undefined;
      return {
        ...(coveredBySurfaceId ? { coveredBySurfaceId } : {}),
        ...(activeSurfaceId ? { activeSurfaceId } : {}),
      };
    };
    if (action && !/^(screenshot|ariaSnapshot|innerText|textContent|getAttribute|inputValue|count)$/.test(action)) {
      rememberSurfaceSource(element);
    }
    const targetStyle = visibleDomStyle(element);
    if (pointerAction && targetStyle?.pointerEvents === 'none') {
      return { ok: false, reason: `${targetDescriptor} has computed pointer-events:none`, descriptor: targetDescriptor };
    }
    let current: Element | undefined = element;
    for (let guard = 0; current && guard < 256; guard += 1) {
      if (isOverlay(current)) {
        return { ok: false, reason: `${descriptor(current)} belongs to the automation overlay`, descriptor: targetDescriptor };
      }
      if (current.hasAttribute('hidden')) {
        return { ok: false, reason: `${descriptor(current)} has the hidden attribute`, descriptor: targetDescriptor };
      }
      if ((current as HTMLElement).inert || current.hasAttribute('inert')) {
        return { ok: false, reason: `${descriptor(current)} or an ancestor is inert`, descriptor: targetDescriptor };
      }
      const style = visibleDomStyle(current);
      if (!style) {
        return { ok: false, reason: `computed style is unavailable for ${descriptor(current)}`, descriptor: targetDescriptor };
      }
      if (!fileInputAction && style.display === 'none') {
        return { ok: false, reason: `${descriptor(current)} or an ancestor has display:none`, descriptor: targetDescriptor };
      }
      if (!fileInputAction && (style.visibility === 'hidden' || style.visibility === 'collapse')) {
        return { ok: false, reason: `${descriptor(current)} or an ancestor has visibility:${style.visibility}`, descriptor: targetDescriptor };
      }
      if (!fileInputAction && (style.contentVisibility === 'hidden' || Number(style.opacity || '1') <= 0.01)) {
        return { ok: false, reason: `${descriptor(current)} or an ancestor is not visibly rendered`, descriptor: targetDescriptor };
      }
      current = flatParentElement(current);
    }
    const disabled = (() => {
      try {
        return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
      } catch {
        return element.getAttribute('aria-disabled') === 'true';
      }
    })();
    if (disabled) return { ok: false, reason: `${targetDescriptor} is disabled`, descriptor: targetDescriptor };
    if (!fileInputAction) {
      const renderedRect = Array.from(element.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
      if (!renderedRect) {
        return { ok: false, reason: `${targetDescriptor} has no rendered client rectangle`, descriptor: targetDescriptor };
      }
      if (pointerAction) {
        const intersectsViewport = renderedRect.right > 0
          && renderedRect.bottom > 0
          && renderedRect.left < window.innerWidth
          && renderedRect.top < window.innerHeight;
        const currentViewportBlocker = viewportBlockingLayer(topmostRenderableAt(
          Math.max(0, Math.floor(window.innerWidth / 2)),
          Math.max(0, Math.floor(window.innerHeight / 2)),
          { requirePointerEvents: true },
        ));
        if (!intersectsViewport && currentViewportBlocker) {
          return {
            ok: false,
            reason: `${targetDescriptor} is outside the viewport behind viewport-blocking layer ${descriptor(currentViewportBlocker)}`,
            descriptor: targetDescriptor,
            failureKind: 'occluded' as const,
            coveredBy: descriptor(currentViewportBlocker),
            ...surfaceFailureContext(currentViewportBlocker),
            preserveScroll: true,
          };
        }
        if (!intersectsViewport && targetStyle?.position === 'fixed') {
          return {
            ok: false,
            reason: `${targetDescriptor} is fixed outside the viewport`,
            descriptor: targetDescriptor,
          };
        }
        if (intersectsViewport && !visiblePointForElement(element, { requirePointerEvents: true })) {
          const centerX = Math.min(window.innerWidth - 1, Math.max(0, renderedRect.left + renderedRect.width / 2));
          const centerY = Math.min(window.innerHeight - 1, Math.max(0, renderedRect.top + renderedRect.height / 2));
          const coveredBy = topmostRenderableAt(centerX, centerY, { requirePointerEvents: true });
          const blockingLayer = viewportBlockingLayer(coveredBy);
          return {
            ok: false,
            reason: blockingLayer
              ? `${targetDescriptor} is covered by viewport-blocking layer ${descriptor(blockingLayer)}`
              : `${targetDescriptor} has no unobstructed actionable point`,
            descriptor: targetDescriptor,
            failureKind: 'occluded' as const,
            ...(coveredBy ? { coveredBy: descriptor(coveredBy) } : {}),
            ...surfaceFailureContext(blockingLayer || coveredBy),
            ...(blockingLayer ? { preserveScroll: true } : {}),
          };
        }
      }
    }
    if (/^(fill|type|clear|presssequentially)$/.test(action)) {
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      const contentEditable = (element as HTMLElement).isContentEditable;
      if (!contentEditable && !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: `${targetDescriptor} is not an editable input, textarea, or contenteditable element`, descriptor: targetDescriptor };
      }
      if (!contentEditable && (field.readOnly || field.disabled)) {
        return { ok: false, reason: `${targetDescriptor} is readonly or disabled`, descriptor: targetDescriptor };
      }
    }
    if (action === 'selectoption' && !(element instanceof HTMLSelectElement)) {
      return { ok: false, reason: `${targetDescriptor} is not a native select element`, descriptor: targetDescriptor };
    }
    return { ok: true, reason: 'exact live element is actionable', descriptor: targetDescriptor };
  }

  function selectVisibleDomOption(ref: string, input: { value?: string; label?: string }) {
    const element = visibleDomState().refToElement.get(ref);
    if (!(element instanceof HTMLSelectElement) || !element.isConnected) {
      return { ok: false, actual: 'UID is not a live native select element.' };
    }
    const value = normalizeVisibleDomText(input.value || '');
    const label = normalizeVisibleDomText(input.label || '');
    if (!value && !label) return { ok: false, actual: 'selectOption requires a non-empty value or label.' };
    const option = Array.from(element.options).find((candidate) => (
      (value && candidate.value === value)
      || (!value && label && normalizeVisibleDomText(candidate.label || candidate.text || candidate.textContent || '') === label)
    ));
    if (!option) return { ok: false, actual: `No option matched ${value ? `value=${value}` : `label=${label}`}.` };
    if (option.disabled || element.disabled) return { ok: false, actual: 'The requested select option is disabled.' };
    const previousValue = element.value;
    element.value = option.value;
    if (element.value !== option.value) return { ok: false, actual: 'The native select rejected the requested option value.' };
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      actual: previousValue === option.value ? 'The requested option was already selected.' : 'Native select value changed and input/change events were dispatched.',
      value: option.value,
      label: normalizeVisibleDomText(option.label || option.text || option.textContent || option.value),
    };
  }

  const surfaceEntryForEvent = (event: Event) => {
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (!target) return undefined;
    const state = resolveSurfaceState();
    return state.entries
      .filter((entry) => composedContains(entry.element, target))
      .sort((left, right) => right.surface.depth - left.surface.depth || right.score - left.score)[0];
  };
  const rememberSurfaceInteraction = (event: Event) => {
    const entry = surfaceEntryForEvent(event);
    if (!entry) return;
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (target) rememberSurfaceSource(target);
  };
  const rememberSurfaceFocus = (event: Event) => {
    const entry = surfaceEntryForEvent(event);
    if (!entry) return;
    surfaceActivationOrder.set(entry.element, ++surfaceActivationSequence);
    cachedSurfaceEpoch = -1;
  };
  document.addEventListener('pointerdown', rememberSurfaceInteraction, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') rememberSurfaceInteraction(event);
  }, true);
  document.addEventListener('focusin', rememberSurfaceFocus, true);

  win.__aiDomRuntime = {
    version: runtimeVersion,
    mutationState: () => ({ epoch: mutationState.epoch, lastMutationAt: mutationState.lastMutationAt }),
    pageObservation,
    activeSurfaceElement: () => resolveSurfaceState().activeEntry?.element,
    markSurfaceInteraction: rememberSurfaceSource,
    actionability,
    isOverlay,
    isTraversable,
    isRenderable,
    children,
    flatParentElement,
    composedContains,
    elementFromPath,
    pathOf,
    descriptor,
    textOf,
    recordedEventTypes,
    hasActionAttribute,
    hasPointerCursor,
    isContentEditableOwner,
    labelControlFor,
    visibleDomHoverElements,
    isActionable,
    actionableTargetFor,
    visibleRect,
    elementBox,
    topmostRenderableAt,
    pointBelongsToElement,
    visiblePointForElement,
    scrollState,
    visibleDomSnapshot,
    fullDomSnapshot,
    visibleDomDelta,
    discardDomChanges,
    journalDomDelta,
    discardDomJournal,
    elementText,
    visibleDomElement,
    visibleDomPoint,
    visibleDomText,
    selectVisibleDomOption,
    findVisibleDomVirtualOption,
    scrollVisibleDomVirtualList,
  };
}

export function collectAiDomObservation(input: { includeInteractiveCandidates?: boolean; requirePointerEvents?: boolean; structuredTextMaxChars?: number; debugPause?: boolean; candidateTextQuery?: string }): PageDomObservationPayload {
  if (input.debugPause) {
    debugger;
  }
  const runtime = (window as WindowWithAiDomRuntime).__aiDomRuntime!;
  if (!runtime) return { structuredText: '', interactiveCandidates: [], links: [] };

  const includeInteractiveCandidates = input.includeInteractiveCandidates !== false;
  const requirePointerEvents = input.requirePointerEvents === true;
  const maxStructuredTextChars = Math.max(0, Math.floor(Number(input.structuredTextMaxChars) || 0));
  const structuredLines: string[] = [];
  const pageLinks = new Map<string, { url: string; title: string }>();
  let structuredChars = 0;
  const normalizeText = (value?: string | null) => String(value || '').replace(/\s+/g, ' ').trim();
  const candidateTextQuery = normalizeText(input.candidateTextQuery).toLowerCase();
  const candidateTextQueryParts = candidateTextQuery.split(/\s+/).filter((item) => item.length >= 2);
  const overlaySelector = '#__ai_candidate_overlay__, #__ai_mouse_cursor__, #__ai_dom_export_control__';
  const skippedTextTags = new Set(['script', 'style', 'template', 'noscript']);
  const structuralTextTags = new Set([
    'article',
    'aside',
    'body',
    'details',
    'dialog',
    'fieldset',
    'footer',
    'form',
    'header',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ]);

  function classNameOf(element: Element) {
    return typeof element.className === 'string'
      ? normalizeText(element.className).split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
      : '';
  }

  function compactClassNameOf(element: Element) {
    return typeof element.className === 'string'
      ? element.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      : '';
  }

  function isHiddenForStructuredText(element: Element) {
    if (element.closest(overlaySelector)) return true;
    const style = window.getComputedStyle(element);
    return style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || Number(style.opacity || '1') <= 0.01;
  }

  function appendStructuredText(depth: number, text: string) {
    if (!maxStructuredTextChars || !text || structuredChars >= maxStructuredTextChars) return;
    const line = `${'  '.repeat(Math.min(depth, 12))}${text}`;
    const remaining = maxStructuredTextChars - structuredChars;
    const chunk = line.length > remaining ? line.slice(0, remaining) : line;
    if (!chunk) return;
    structuredLines.push(chunk);
    structuredChars += chunk.length + 1;
  }

  function structuredTextLine(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (skippedTextTags.has(tag) || isHiddenForStructuredText(element)) return undefined;
    const role = element.getAttribute('role');
    const classes = compactClassNameOf(element);
    const descriptor = `${tag}${classes ? `.${classes}` : ''}${role ? `[role=${role}]` : ''}`;
    const inputElement = element as HTMLInputElement;
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('alt'),
      inputElement.placeholder,
      inputElement.value,
      ownText(element),
    ].map(normalizeText).find(Boolean) || '';
    const shouldShow = Boolean(label)
      || structuralTextTags.has(tag)
      || ['button', 'a', 'input', 'select', 'textarea', 'option'].includes(tag);
    return shouldShow ? { shown: true, text: label ? `${descriptor}: ${label}` : descriptor } : { shown: false, text: '' };
  }

  function flatParentElement(node: Node) {
    return runtime.flatParentElement(node);
  }

  const hasPointerCursor = runtime.hasPointerCursor;

  function composedContains(ancestor: Element, node: Element) {
    return runtime.composedContains(ancestor, node);
  }

  function isInsideShadow(element: Element) {
    const root = element.getRootNode();
    return Boolean(root && (root as ShadowRoot).host);
  }

  function visibleRectOf(element: Element) {
    return runtime.visibleRect(element, { requirePointerEvents });
  }

  function children(element: Element) {
    return runtime.children(element);
  }

  function ownText(element: Element) {
    let text = '';
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
    }
    const inner = normalizeText((element as HTMLElement).innerText || element.textContent || '');
    return (normalizeText(text) || inner).slice(0, 140);
  }

  function contextText(element: Element) {
    const container = element.closest('li, article, tr, form, [role="listitem"], [role="row"], section, main') || element.parentElement || element;
    return normalizeText((container as HTMLElement).innerText || container.textContent || '').slice(0, 220);
  }

  function labelMatchesCandidateTextQuery(value?: string | null) {
    if (!candidateTextQuery) return true;
    const label = normalizeText(value).toLowerCase();
    if (!label) return false;
    if (label === candidateTextQuery) return true;
    if (label.startsWith(candidateTextQuery)) return true;
    if (label.includes(candidateTextQuery)) return true;
    return candidateTextQueryParts.length >= 2 && candidateTextQueryParts.every((part) => label.includes(part));
  }

  function labelsMatchCandidateTextQuery(labels: Array<string | undefined>) {
    return !candidateTextQuery || labels.some(labelMatchesCandidateTextQuery);
  }

  function recordedEventTypes(element: Element) {
    return runtime.recordedEventTypes(element);
  }

  function hasRecordedClickListener(element: Element) {
    return recordedEventTypes(element).some((type) => /^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/.test(type));
  }

  function hasRecordedHoverListener(element: Element) {
    return recordedEventTypes(element).some((type) => /^(mouseenter|mouseover|pointerenter|pointerover)$/.test(type));
  }

  function hasActionAttribute(element: Element) {
    return runtime.hasActionAttribute(element);
  }

  function hasOwnHoverSignal(element: Element) {
    if (element.hasAttribute('onmouseenter')) return true;
    if (element.hasAttribute('onmouseover')) return true;
    if (element.hasAttribute('onpointerenter')) return true;
    if (element.hasAttribute('onpointerover')) return true;
    return hasRecordedHoverListener(element);
  }

  const hoverElements = runtime.visibleDomHoverElements();

  function hasCssHoverEffect(element: Element) {
    const className = typeof element.className === 'string' ? element.className : '';
    if (/(^|\s)hover[:_-]/.test(className)) return true;
    return hoverElements.has(element);
  }

  const isContentEditableOwner = runtime.isContentEditableOwner;
  const labelControlFor = runtime.labelControlFor;

  function interactionSignals(element: Element, tag = element.tagName.toLowerCase()) {
    const signals: string[] = [];
    if (
      ['button', 'details', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag) ||
      (tag === 'a' && element.hasAttribute('href')) ||
      (tag === 'label' && labelControlFor(element))
    ) {
      signals.push('native');
    }
    if (element.hasAttribute('onclick')) signals.push('onclick');
    if (hasRecordedClickListener(element)) signals.push('listener');
    if (hasActionAttribute(element)) signals.push('action-attr');
    if (hasPointerCursor(element)) signals.push('cursor=pointer');
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') signals.push('tabindex');
    if (isContentEditableOwner(element)) signals.push('contenteditable');
    if (hasOwnHoverSignal(element)) signals.push('hover-listener');
    if (hasCssHoverEffect(element)) signals.push('hover-css');
    return signals;
  }

  function clickableReason(element: Element) {
    return interactionSignals(element).length > 0;
  }

  function isInteractiveDescendant(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'label' && labelControlFor(element)) return true;
    const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
    return clickableReason(element) || isInput || hasOwnHoverSignal(element) || hasCssHoverEffect(element);
  }

  function externalAppTargetForUrl(value?: string | null) {
    const url = normalizeText(value);
    const match = url.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!match) return undefined;
    const protocol = match[1].toLowerCase();
    if ([
      'http',
      'https',
      'about',
      'blob',
      'data',
      'javascript',
      'file',
      'chrome',
      'chrome-extension',
      'edge',
      'devtools',
      'view-source',
    ].includes(protocol)) return undefined;
    return { protocol };
  }

  function externalAppTargetForElement(element: Element, href?: string) {
    const direct = externalAppTargetForUrl(href || element.getAttribute('href'));
    if (direct) return direct;

    const attributeNames = [
      'data-href',
      'data-url',
      'data-link',
      'data-uri',
      'data-deeplink',
      'data-deep-link',
      'data-scheme',
      'data-target-url',
    ];
    for (const name of attributeNames) {
      const value = element.getAttribute(name);
      const result = externalAppTargetForUrl(value)
        || (name === 'data-scheme' && /^[a-z][a-z0-9+.-]*$/i.test(normalizeText(value))
          ? externalAppTargetForUrl(`${normalizeText(value)}:`)
          : undefined);
      if (result) return result;
    }

    const inlineHandler = element.getAttribute('onclick') || '';
    const handlerMatch = inlineHandler.match(/['"]([a-z][a-z0-9+.-]*:[^'"]*)['"]/i);
    return externalAppTargetForUrl(handlerMatch?.[1]);
  }

  function nameOf(element: Element) {
    const inputElement = element as HTMLInputElement;
    const labelText = inputElement.labels?.length ? Array.from(inputElement.labels).map((label) => label.textContent || '').join(' ') : '';
    const imageAlt = Array.from(element.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') || '').join(' ');
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('alt'),
      imageAlt,
      inputElement.placeholder,
      labelText,
      ownText(element),
      inputElement.value,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function topmostRenderableAt(x: number, y: number) {
    return runtime.topmostRenderableAt(x, y, { requirePointerEvents });
  }

  function isIndependentPointForOwner(owner: Element, top: Element) {
    if (top !== owner && !composedContains(owner, top)) return false;
    let current: Element | undefined = top;
    let guard = 0;
    while (current && current !== owner && guard < 256) {
      if (isInteractiveDescendant(current)) return false;
      current = flatParentElement(current);
      guard += 1;
    }
    return current === owner;
  }

  function isInteriorSamplePoint(rect: NonNullable<ReturnType<typeof visibleRectOf>>, x: number, y: number) {
    const insetX = Math.min(12, Math.max(4, rect.width * 0.12));
    const insetY = Math.min(12, Math.max(4, rect.height * 0.12));
    if (rect.width <= insetX * 2 || rect.height <= insetY * 2) return false;
    return (
      x >= rect.left + insetX &&
      x <= rect.right - insetX &&
      y >= rect.top + insetY &&
      y <= rect.bottom - insetY
    );
  }

  function interactiveDescendantRects(owner: Element) {
    const rects: Array<NonNullable<ReturnType<typeof visibleRectOf>>> = [];
    const queue = [...children(owner)];
    let guard = 0;
    while (queue.length && guard < 4000) {
      const child = queue.shift() as Element;
      if (isInteractiveDescendant(child)) {
        const rect = visibleRectOf(child);
        if (rect) rects.push(rect);
      }
      queue.push(...children(child));
      guard += 1;
    }
    return rects;
  }

  function isSeparatedFromInteractiveDescendants(
    descendantRects: Array<NonNullable<ReturnType<typeof visibleRectOf>>>,
    x: number,
    y: number,
  ) {
    const clearance = 10;
    return descendantRects.every(
      (rect) =>
        x < rect.left - clearance ||
        x > rect.right + clearance ||
        y < rect.top - clearance ||
        y > rect.bottom + clearance,
    );
  }

  function computeVisibility(element: Element, rect: ReturnType<typeof visibleRectOf>) {
    if (!rect) return undefined;
    const cols = rect.width >= 80 ? 5 : 3;
    const rows = rect.height >= 60 ? 5 : 3;
    const points: Array<{ x: number; y: number; gridRow?: number; gridCol?: number }> = [
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    ];
    const edgeInsetX = Math.min(2, Math.max(0.5, rect.width / 8));
    const edgeInsetY = Math.min(2, Math.max(0.5, rect.height / 8));
    points.push(
      { x: rect.left + edgeInsetX, y: rect.top + edgeInsetY },
      { x: rect.right - edgeInsetX, y: rect.top + edgeInsetY },
      { x: rect.left + edgeInsetX, y: rect.bottom - edgeInsetY },
      { x: rect.right - edgeInsetX, y: rect.bottom - edgeInsetY },
      { x: rect.left + edgeInsetX, y: rect.top + rect.height / 2 },
      { x: rect.right - edgeInsetX, y: rect.top + rect.height / 2 },
      { x: rect.left + rect.width / 2, y: rect.top + edgeInsetY },
      { x: rect.left + rect.width / 2, y: rect.bottom - edgeInsetY },
    );
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        points.push({
          x: rect.left + ((col + 0.5) / cols) * rect.width,
          y: rect.top + ((row + 0.5) / rows) * rect.height,
          gridRow: row,
          gridCol: col,
        });
      }
    }

    let owned = 0;
    let covered = 0;
    let visiblePoint: { x: number; y: number } | undefined;
    let independentInteriorPoint: { x: number; y: number } | undefined;
    let interiorPointCount = 0;
    const independentGridPoints = new Set<string>();
    const descendantRects = interactiveDescendantRects(element);
    for (const point of points) {
      const { x, y, gridRow, gridCol } = point;
      const px = Math.min(Math.max(x, 0), window.innerWidth - 1);
      const py = Math.min(Math.max(y, 0), window.innerHeight - 1);
      const isInteriorGridPoint =
        gridRow !== undefined &&
        gridCol !== undefined &&
        isInteriorSamplePoint(rect, px, py);
      if (isInteriorGridPoint) interiorPointCount += 1;
      const top = topmostRenderableAt(px, py);
      if (!top) continue;
      if (top === element || composedContains(element, top)) {
        owned += 1;
        if (!visiblePoint) visiblePoint = { x: Math.round(px), y: Math.round(py) };
        if (
          isInteriorGridPoint &&
          isIndependentPointForOwner(element, top) &&
          isSeparatedFromInteractiveDescendants(descendantRects, px, py)
        ) {
          independentGridPoints.add(`${gridRow}:${gridCol}`);
          if (!independentInteriorPoint) independentInteriorPoint = { x: Math.round(px), y: Math.round(py) };
        }
      } else if (!composedContains(top, element)) {
        covered += 1;
      }
    }

    const hasAdjacentIndependentPoints = Array.from(independentGridPoints).some((key) => {
      const [row, col] = key.split(':').map(Number);
      return (
        independentGridPoints.has(`${row - 1}:${col}`) ||
        independentGridPoints.has(`${row + 1}:${col}`) ||
        independentGridPoints.has(`${row}:${col - 1}`) ||
        independentGridPoints.has(`${row}:${col + 1}`)
      );
    });
    const total = points.length;
    return {
      visiblePoint,
      independentInteriorPoint,
      independentInteriorPointCount: independentGridPoints.size,
      interiorPointCount,
      hasAdjacentIndependentPoints,
      ownedRatio: owned / total,
      coveredRatio: covered / total,
    };
  }

  function visibleProxyForZeroSizeOwner(element: Element) {
    const queue = [...children(element)];
    let guard = 0;
    while (queue.length && guard < 4000) {
      const child = queue.shift() as Element;
      const tag = child.tagName.toLowerCase();
      const childInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(child);
      const childInteractive = clickableReason(child) || childInput || hasOwnHoverSignal(child) || hasCssHoverEffect(child);
      const rect = visibleRectOf(child);
      if (tag !== 'label' && !childInteractive && rect) {
        const visibility = computeVisibility(element, rect);
        if (visibility?.visiblePoint && !(visibility.coveredRatio > 0.5 && visibility.ownedRatio < 0.35)) return { rect, visibility };
      }
      queue.push(...children(child));
      guard += 1;
    }
    return undefined;
  }

  function candidateFrom(element: Element, path: number[]): PageInteractiveCandidate | undefined {
    const tag = element.tagName.toLowerCase();
    const labelControl = labelControlFor(element);
    const role = element.getAttribute('role') || undefined;
    const inputElement = element as HTMLInputElement;
    const isInput = ['input', 'textarea', 'select'].includes(tag) || isContentEditableOwner(element);
    const signals = interactionSignals(element, tag);
    const clickable = signals.length > 0;
    if (!clickable && !isInput) return undefined;

    const href = tag === 'a' ? ((element as HTMLAnchorElement).href || element.getAttribute('href') || undefined) : undefined;
    const text = ownText(element);
    const name = nameOf(element);
    const placeholder = inputElement.placeholder || undefined;
    const ariaLabel = element.getAttribute('aria-label') || undefined;
    const title = element.getAttribute('title') || undefined;
    let nearbyText: string | undefined;
    if (!labelsMatchCandidateTextQuery([name, text, ariaLabel || undefined, title || undefined, placeholder, href])) {
      nearbyText = contextText(element) || undefined;
      if (!labelsMatchCandidateTextQuery([nearbyText])) return undefined;
    }

    let rect = visibleRectOf(element);
    let visibility = rect ? computeVisibility(element, rect) : undefined;
    if (!rect && clickable) {
      const proxy = visibleProxyForZeroSizeOwner(element);
      rect = proxy?.rect;
      visibility = proxy?.visibility;
    }
    if (!rect || !visibility?.visiblePoint) return undefined;
    if (visibility.coveredRatio > 0.5 && visibility.ownedRatio < 0.35) return undefined;

    const hasIndependentClickArea =
      clickable &&
      visibility.hasAdjacentIndependentPoints &&
      visibility.independentInteriorPointCount >= 2 &&
      visibility.independentInteriorPointCount / Math.max(1, visibility.interiorPointCount) >= 0.15;
    const visiblePoint = hasIndependentClickArea
      ? visibility.independentInteriorPoint || visibility.visiblePoint
      : visibility.visiblePoint;
    const viewportArea = window.innerWidth * window.innerHeight;
    const area = rect.width * rect.height;
    if (area > viewportArea * 0.75 && !['input', 'textarea', 'select', 'button', 'a'].includes(tag)) return undefined;

    let host: string | undefined;
    try {
      host = href ? new URL(href).hostname : undefined;
    } catch {
      host = undefined;
    }
    const externalAppTarget = externalAppTargetForElement(element, href);

    const className = classNameOf(element);
    const type = tag === 'input' || tag === 'button' ? element.getAttribute('type') || undefined : undefined;
    nearbyText ||= contextText(element) || undefined;

    return {
      id: '',
      path: path.join('.'),
      tag,
      role,
      type,
      name: name || undefined,
      text: text || undefined,
      className: className || undefined,
      signals: signals.length ? signals : undefined,
      nearbyText,
      href,
      host,
      opensExternalApp: externalAppTarget ? true : undefined,
      externalAppProtocol: externalAppTarget?.protocol,
      placeholder,
      ariaLabel,
      title,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      center: {
        x: Math.round(visiblePoint.x),
        y: Math.round(visiblePoint.y),
      },
      clickable,
      input: isInput,
      disabled: Boolean(
        inputElement.disabled ||
        (labelControl && (labelControl as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement).disabled) ||
        element.getAttribute('aria-disabled') === 'true',
      ),
      hasIndependentClickArea,
      shadow: isInsideShadow(element),
    };
  }

  function pathParts(value: string) {
    return value.split('.').map((item) => Number(item));
  }

  function comparePath(a: string, b: string) {
    const ap = pathParts(a);
    const bp = pathParts(b);
    const length = Math.min(ap.length, bp.length);
    for (let index = 0; index < length; index += 1) {
      if (ap[index] !== bp[index]) return ap[index] - bp[index];
    }
    return ap.length - bp.length;
  }

  const raw: PageInteractiveCandidate[] = [];
  const seenPaths = new Set<string>();
  let visitedElements = 0;

  function pushCandidate(element: Element, path: number[]) {
    const pathKey = path.join('.');
    if (seenPaths.has(pathKey)) return;
    if (!includeInteractiveCandidates) return;
    const candidate = candidateFrom(element, path);
    if (!candidate) return;
    raw.push(candidate);
    seenPaths.add(pathKey);
  }

  function walk(element: Element, path: number[], depth: number, textDepth: number) {
    visitedElements += 1;
    if (visitedElements > 50000 || depth > 128) return;
    if (window.getComputedStyle(element).display === 'none') return;
    if (element instanceof HTMLAnchorElement && element.href && /^https?:\/\//i.test(element.href)) {
      const title = normalizeText(element.textContent)
        || normalizeText(element.getAttribute('title'))
        || normalizeText(element.getAttribute('aria-label'))
        || normalizeText(element.querySelector('img')?.getAttribute('alt'))
        || element.href;
      pageLinks.set(element.href.toLowerCase(), { url: element.href, title });
    }
    const structured = maxStructuredTextChars ? structuredTextLine(element) : undefined;
    const nextTextDepth = structured?.shown ? textDepth + 1 : textDepth;
    if (structured?.text) appendStructuredText(textDepth, structured.text);
    pushCandidate(element, path);
    const childNodes = children(element);
    for (let index = 0; index < childNodes.length; index += 1) {
      walk(childNodes[index], [...path, index], depth + 1, nextTextDepth);
    }
  }

  walk(document.documentElement, [0], 0, 0);

  const candidates = raw
    .sort((a, b) => comparePath(a.path, b.path) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return {
    structuredText: structuredLines.join('\n'),
    interactiveCandidates: candidates.map((candidate, index) => ({ ...candidate, id: `${index + 1}` })),
    links: Array.from(pageLinks.values()).slice(0, 300),
  };
}

export function applyPageGroupMarker(input: { id: string; title: string; prefix: string; applyPrefix: boolean }) {
  Object.defineProperty(window, '__aiWebTestSessionGroupId', {
    configurable: true,
    enumerable: false,
    value: input.id,
    writable: true,
  });
  if (document.documentElement?.getAttribute('data-ai-web-test-session-group-id') !== input.id) {
    document.documentElement?.setAttribute('data-ai-web-test-session-group-id', input.id);
  }
  if (document.documentElement?.getAttribute('data-ai-web-test-session-group-title') !== input.title) {
    document.documentElement?.setAttribute('data-ai-web-test-session-group-title', input.title);
  }
  const windowNameMarker = `AI_WEB_TEST_SESSION_GROUP:${input.id};`;
  const previousWindowName = String(window.name || '').replace(/^AI_WEB_TEST_SESSION_GROUP:[^;]*;/, '');
  const nextWindowName = `${windowNameMarker}${previousWindowName}`;
  if (window.name !== nextWindowName) window.name = nextWindowName;
  window.postMessage({
    source: 'AI_WEB_TEST_SESSION_TAB_GROUP',
    type: 'group-tab',
    sessionId: input.id,
    groupTitle: input.title,
  }, '*');

  if (!input.applyPrefix) return;
  const stateKey = '__aiWebTestTabGroupTitleState';
  const win = window as Window & {
    [stateKey]?: {
      applying?: boolean;
      observer?: MutationObserver;
      prefix: string;
    };
  };
  const state = win[stateKey] || { prefix: input.prefix };
  state.prefix = input.prefix;
  win[stateKey] = state;
  const apply = () => {
    if (state.applying) return;
    const current = document.title || '';
    const prefixes = /^【(?:AI会话|ai-)[^】]*】\s*/i;
    const clean = current.replace(prefixes, '').trim();
    const next = `${state.prefix}${clean ? ` ${clean}` : ''}`;
    if (current === next) return;
    state.applying = true;
    document.title = next;
    state.applying = false;
  };
  apply();
  if (!state.observer) {
    state.observer = new MutationObserver(apply);
    const titleElement = document.querySelector('title');
    if (titleElement) state.observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
  }
}
