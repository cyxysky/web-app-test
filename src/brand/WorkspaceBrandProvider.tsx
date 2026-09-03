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

const PREFIX_STORAGE_KEY = 'webpilotqa.brandPrefix';
const TEXT_STORAGE_KEY = 'webpilotqa.brandText';
const MAX_BRAND_PART_LENGTH = 48;
const DEFAULT_BRAND_PREFIX = String(process.env.NEXT_PUBLIC_WEBPILOT_BRAND_PREFIX || 'DOMP').trim() || 'DOMP';
const DEFAULT_BRAND_TEXT = String(process.env.NEXT_PUBLIC_WEBPILOT_BRAND_TEXT || 'WebPilot').trim() || 'WebPilot';

type WorkspaceBrandContextValue = {
  brandPrefix: string;
  brandText: string;
  setBrandPrefix: (value: string) => void;
  setBrandText: (value: string) => void;
};

const WorkspaceBrandContext = createContext<WorkspaceBrandContextValue | undefined>(undefined);

function boundedBrandPart(value: string) {
  return value.slice(0, MAX_BRAND_PART_LENGTH);
}

function storedBrandPart(key: string, fallback: string) {
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : boundedBrandPart(stored);
}

export function WorkspaceBrandProvider({ children }: { children: ReactNode }) {
  const [brandPrefix, setBrandPrefixState] = useState(DEFAULT_BRAND_PREFIX);
  const [brandText, setBrandTextState] = useState(DEFAULT_BRAND_TEXT);

  useEffect(() => {
    const syncStoredBrand = () => {
      setBrandPrefixState(storedBrandPart(PREFIX_STORAGE_KEY, DEFAULT_BRAND_PREFIX));
      setBrandTextState(storedBrandPart(TEXT_STORAGE_KEY, DEFAULT_BRAND_TEXT));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PREFIX_STORAGE_KEY || event.key === TEXT_STORAGE_KEY) {
        syncStoredBrand();
      }
    };
    syncStoredBrand();
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setBrandPrefix = useCallback((value: string) => {
    const nextValue = boundedBrandPart(value);
    setBrandPrefixState(nextValue);
    window.localStorage.setItem(PREFIX_STORAGE_KEY, nextValue);
  }, []);

  const setBrandText = useCallback((value: string) => {
    const nextValue = boundedBrandPart(value);
    setBrandTextState(nextValue);
    window.localStorage.setItem(TEXT_STORAGE_KEY, nextValue);
  }, []);

  const contextValue = useMemo<WorkspaceBrandContextValue>(() => ({
    brandPrefix,
    brandText,
    setBrandPrefix,
    setBrandText,
  }), [brandPrefix, brandText, setBrandPrefix, setBrandText]);

  return (
    <WorkspaceBrandContext.Provider value={contextValue}>
      {children}
    </WorkspaceBrandContext.Provider>
  );
}

export function useWorkspaceBrand() {
  const context = useContext(WorkspaceBrandContext);
  if (!context) throw new Error('useWorkspaceBrand must be used inside WorkspaceBrandProvider');
  return context;
}
