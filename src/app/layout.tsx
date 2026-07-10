import type { Metadata } from 'next';
import { InterfaceMotion } from '@/components/InterfaceMotion';
import { NavigationLoading } from '@/components/NavigationLoading';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ThemeProvider } from '@/theme/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'WebPilot QA',
  description: 'AI-assisted browser testing and evidence reporting.',
};

const themeBootScript = `
try {
  var mode = window.localStorage.getItem('webpilotqa.themeMode') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.setProperty('color-scheme', mode);
} catch {}
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ThemeProvider>
          <I18nProvider>
            <InterfaceMotion />
            {children}
            <NavigationLoading />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
