'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  hasChinese,
  isKnownEnglish,
  normalizeLanguage,
  translateText,
  type Language,
} from '@/i18n/translations';

const STORAGE_KEY = 'webpilotqa.language';
const COOKIE_KEY = 'WEBPILOTQA_LANGUAGE';
const ATTRIBUTES = ['aria-label', 'placeholder', 'title', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'KBD', 'SAMP', 'TEXTAREA']);
const SKIP_SELECTORS = [
  '[data-i18n-skip]',
  '.browser-chat-agent-markdown',
  '.markdown-report',
  '.rich-text-editor',
  '.tox',
];

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (value: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function readInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY));
}

function shouldSkipElement(element: Element | null) {
  for (let current = element; current; current = current.parentElement) {
    if (SKIP_TAGS.has(current.tagName)) return true;
    if (current instanceof HTMLElement && current.isContentEditable) return true;
    if (SKIP_SELECTORS.some((selector) => current.matches(selector))) return true;
  }
  return false;
}

function translateWithWhitespace(language: Language, value: string) {
  const leading = value.match(/^\s*/)?.[0] || '';
  const trailing = value.match(/\s*$/)?.[0] || '';
  const core = value.slice(leading.length, value.length - trailing.length);
  if (!core) return value;
  return `${leading}${translateText(language, core)}${trailing}`;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>('zh');
  const textOriginalsRef = useRef(new WeakMap<Text, string>());
  const attributeOriginalsRef = useRef(new WeakMap<Element, Map<string, string>>());

  useEffect(() => {
    setLanguageState(readInitialLanguage());
  }, []);

  const setLanguage = useCallback((nextLanguage: Language) => {
    const normalized = normalizeLanguage(nextLanguage);
    setLanguageState(normalized);
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, normalized);
    document.cookie = `${COOKIE_KEY}=${normalized}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  const t = useCallback((value: string, params?: Record<string, string | number>) => (
    translateText(language, value, params)
  ), [language]);

  useEffect(() => {
    const textOriginals = textOriginalsRef.current;
    const attributeOriginals = attributeOriginalsRef.current;

    function translateTextNode(node: Text) {
      if (shouldSkipElement(node.parentElement)) return;
      const current = node.nodeValue || '';
      let original = textOriginals.get(node);
      if (original && hasChinese(current) && current !== original) {
        original = current;
        textOriginals.set(node, original);
      }
      if (!original) {
        if (language === 'en' && hasChinese(current)) {
          original = current;
          textOriginals.set(node, original);
        } else if (language === 'zh' && isKnownEnglish(current.trim())) {
          original = current;
          textOriginals.set(node, original);
        } else {
          original = current;
        }
      }
      const next = language === 'zh'
        ? translateWithWhitespace('zh', original)
        : translateWithWhitespace('en', original);
      if (node.nodeValue !== next) node.nodeValue = next;
    }

    function translateAttributes(element: Element) {
      if (shouldSkipElement(element)) return;
      let originals = attributeOriginals.get(element);
      for (const attr of ATTRIBUTES) {
        const current = element.getAttribute(attr);
        if (!current) continue;
        if (!originals) {
          originals = new Map<string, string>();
          attributeOriginals.set(element, originals);
        }
        const original = originals.get(attr)
          || ((language === 'en' && hasChinese(current)) || (language === 'zh' && isKnownEnglish(current.trim())) ? current : undefined);
        if (original && hasChinese(current) && current !== original) originals.set(attr, current);
        else if (original) originals.set(attr, original);
        const source = originals.get(attr) || current;
        const next = language === 'zh'
          ? translateWithWhitespace('zh', source)
          : translateWithWhitespace('en', source);
        if (current !== next) element.setAttribute(attr, next);
      }
    }

    function translateTree(root: Node) {
      if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root as Text);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
      const container = root as Element | Document;
      if (container instanceof Element) translateAttributes(container);
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text);
        if (node.nodeType === Node.ELEMENT_NODE) translateAttributes(node as Element);
        node = walker.nextNode();
      }
    }

    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    translateTree(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          translateTree(mutation.target);
          continue;
        }
        if (mutation.type === 'attributes') {
          translateTree(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach(translateTree);
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ATTRIBUTES,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [language]);

  const value = useMemo<I18nContextValue>(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}
