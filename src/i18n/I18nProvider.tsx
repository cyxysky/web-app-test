'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { normalizeLanguage, type Language } from '@/i18n/language';

const STORAGE_KEY = 'webpilotqa.language';
const COOKIE_KEY = 'WEBPILOTQA_LANGUAGE';
type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (value: string, params?: Record<string, string | number>) => string;
};

type Translator = (language: Language, value: string, params?: Record<string, string | number>) => string;

const fallbackTranslator: Translator = (_language, value, params) => {
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (
    params[key] === undefined ? match : String(params[key])
  ));
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function readInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>('zh');
  const [translator, setTranslator] = useState<Translator>(() => fallbackTranslator);

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

  useEffect(() => {
    if (language !== 'en') {
      setTranslator(() => fallbackTranslator);
      return;
    }
    let active = true;
    void import('@/i18n/translations').then((module) => {
      if (active) setTranslator(() => module.translateText);
    });
    return () => { active = false; };
  }, [language]);

  const t = useCallback((value: string, params?: Record<string, string | number>) => (
    translator(language, value, params)
  ), [language, translator]);

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
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
