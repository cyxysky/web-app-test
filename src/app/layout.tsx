import type { Metadata } from 'next';
import { NavigationLoading } from '@/components/NavigationLoading';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ThemeProvider } from '@/theme/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'WebPilot QA',
  description: 'AI-assisted browser testing and evidence reporting.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <I18nProvider>
            {children}
            <NavigationLoading />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
