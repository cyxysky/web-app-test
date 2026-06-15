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
const DEFAULT_ACCENT = '#10a37f';

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

type ThemeContextValue = {
  color: string;
  currentColor: ThemeColor;
  scrollbarColor: string;
  setScrollbarColor: (color: string) => void;
  setColor: (color: string) => void;
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

function deriveThemeColor(color: string): ThemeColor {
  const accent = normalizeHexColor(color);
  return {
    accent,
    hover: mixColors(accent, '#000000', 0.12),
    strong: mixColors(accent, '#000000', 0.22),
    soft: mixColors(accent, '#ffffff', 0.9),
    border: mixColors(accent, '#ffffff', 0.68),
    focus: rgba(accent, 0.18),
  };
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

function applyScrollbarColor(color: string) {
  const normalized = normalizeHexColor(color);
  const root = document.documentElement;
  root.style.setProperty('--scrollbar-thumb', normalized);
  root.style.setProperty('--scrollbar-thumb-hover', mixColors(normalized, '#000000', 0.12));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [color, setColorState] = useState(DEFAULT_ACCENT);
  const [scrollbarColor, setScrollbarColorState] = useState(DEFAULT_ACCENT);

  useEffect(() => {
    setColorState(normalizeHexColor(window.localStorage.getItem(STORAGE_KEY)));
    setScrollbarColorState(normalizeHexColor(window.localStorage.getItem(SCROLLBAR_STORAGE_KEY)));
  }, []);

  const currentColor = useMemo(() => deriveThemeColor(color), [color]);

  useEffect(() => {
    applyThemeColor(currentColor);
  }, [currentColor]);

  useEffect(() => {
    applyScrollbarColor(scrollbarColor);
  }, [scrollbarColor]);

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

  const value = useMemo<ThemeContextValue>(() => ({
    color,
    currentColor,
    scrollbarColor,
    setColor,
    setScrollbarColor,
  }), [color, currentColor, scrollbarColor, setColor, setScrollbarColor]);

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
