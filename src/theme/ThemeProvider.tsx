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

const STORAGE_KEY = 'webpilotqa.themeColor';
const SCROLLBAR_STORAGE_KEY = 'webpilotqa.scrollbarColor';
const MODE_STORAGE_KEY = 'webpilotqa.themeMode';
const DEFAULT_ACCENT = '#10a37f';
const DEFAULT_MODE: ThemeMode = 'light';

type Rgb = {
  blue: number;
  green: number;
  red: number;
};

type ThemeColor = {
  accent: string;
  border: string;
  focus: string;
  hover: string;
  soft: string;
  strong: string;
};

export type ThemeMode = 'dark' | 'light';

type ThemeContextValue = {
  color: string;
  currentColor: ThemeColor;
  mode: ThemeMode;
  scrollbarColor: string;
  setMode: (mode: ThemeMode) => void;
  setScrollbarColor: (color: string) => void;
  setColor: (color: string) => void;
  toggleMode: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function normalizeHexColor(value: unknown) {
  if (typeof value !== 'string') return DEFAULT_ACCENT;
  const trimmed = value.trim();
  const legacyPresets: Record<string, string> = {
    blue: '#2563eb',
    orange: '#ea580c',
    purple: '#7c3aed',
    rose: '#e11d48',
    'gpt-green': DEFAULT_ACCENT,
  };
  if (legacyPresets[trimmed]) return legacyPresets[trimmed];
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return DEFAULT_ACCENT;
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'dark' ? 'dark' : DEFAULT_MODE;
}

function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHexColor(hex).slice(1);
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(rgb: Rgb) {
  const toPart = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  return `#${toPart(rgb.red)}${toPart(rgb.green)}${toPart(rgb.blue)}`;
}

function mixColors(source: string, target: string, targetWeight: number) {
  const sourceRgb = hexToRgb(source);
  const targetRgb = hexToRgb(target);
  const sourceWeight = 1 - targetWeight;
  return rgbToHex({
    red: sourceRgb.red * sourceWeight + targetRgb.red * targetWeight,
    green: sourceRgb.green * sourceWeight + targetRgb.green * targetWeight,
    blue: sourceRgb.blue * sourceWeight + targetRgb.blue * targetWeight,
  });
}

function rgba(hex: string, opacity: number) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${opacity})`;
}

function deriveThemeColor(color: string, mode: ThemeMode): ThemeColor {
  const accent = normalizeHexColor(color);
  if (mode === 'dark') {
    return {
      accent,
      hover: mixColors(accent, '#ffffff', 0.12),
      strong: mixColors(accent, '#ffffff', 0.2),
      soft: mixColors(accent, '#111827', 0.82),
      border: mixColors(accent, '#111827', 0.58),
      focus: rgba(accent, 0.24),
    };
  }
  return {
    accent,
    hover: mixColors(accent, '#000000', 0.12),
    strong: mixColors(accent, '#000000', 0.22),
    soft: mixColors(accent, '#ffffff', 0.9),
    border: mixColors(accent, '#ffffff', 0.68),
    focus: rgba(accent, 0.18),
  };
}

function applyThemeMode(mode: ThemeMode) {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.classList.toggle('dark', mode === 'dark');
  root.style.setProperty('color-scheme', mode);
}

function applyThemeColor(option: ThemeColor) {
  const root = document.documentElement;
  root.style.setProperty('--accent', option.accent);
  root.style.setProperty('--accent-hover', option.hover);
  root.style.setProperty('--accent-strong', option.strong);
  root.style.setProperty('--accent-soft', option.soft);
  root.style.setProperty('--accent-border', option.border);
  root.style.setProperty('--blue', option.accent);
  root.style.setProperty('--focus', option.focus);
}

function applyScrollbarColor(color: string, mode: ThemeMode) {
  const normalized = normalizeHexColor(color);
  const root = document.documentElement;
  root.style.setProperty('--scrollbar-thumb', normalized);
  root.style.setProperty('--scrollbar-thumb-hover', mixColors(normalized, mode === 'dark' ? '#ffffff' : '#000000', 0.12));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [color, setColorState] = useState(DEFAULT_ACCENT);
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const [scrollbarColor, setScrollbarColorState] = useState(DEFAULT_ACCENT);

  useEffect(() => {
    setColorState(normalizeHexColor(window.localStorage.getItem(STORAGE_KEY)));
    setModeState(normalizeThemeMode(window.localStorage.getItem(MODE_STORAGE_KEY)));
    setScrollbarColorState(normalizeHexColor(window.localStorage.getItem(SCROLLBAR_STORAGE_KEY)));
  }, []);

  const currentColor = useMemo(() => deriveThemeColor(color, mode), [color, mode]);

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  useEffect(() => {
    applyThemeColor(currentColor);
  }, [currentColor]);

  useEffect(() => {
    applyScrollbarColor(scrollbarColor, mode);
  }, [mode, scrollbarColor]);

  const setColor = useCallback((nextColor: string) => {
    const normalized = normalizeHexColor(nextColor);
    setColorState(normalized);
    window.localStorage.setItem(STORAGE_KEY, normalized);
  }, []);

  const setScrollbarColor = useCallback((nextColor: string) => {
    const normalized = normalizeHexColor(nextColor);
    setScrollbarColorState(normalized);
    window.localStorage.setItem(SCROLLBAR_STORAGE_KEY, normalized);
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    const normalized = normalizeThemeMode(nextMode);
    applyThemeMode(normalized);
    setModeState(normalized);
    window.localStorage.setItem(MODE_STORAGE_KEY, normalized);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((current) => {
      const nextMode = current === 'dark' ? 'light' : 'dark';
      applyThemeMode(nextMode);
      window.localStorage.setItem(MODE_STORAGE_KEY, nextMode);
      return nextMode;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    color,
    currentColor,
    mode,
    scrollbarColor,
    setColor,
    setMode,
    setScrollbarColor,
    toggleMode,
  }), [color, currentColor, mode, scrollbarColor, setColor, setMode, setScrollbarColor, toggleMode]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
