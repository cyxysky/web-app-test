export type Language = 'zh' | 'en';

export const languageOptions: Array<{ value: Language; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

export function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'zh';
}
