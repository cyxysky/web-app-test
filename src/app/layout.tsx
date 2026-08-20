import type { Metadata } from 'next';
import '@open-file-viewer/core/style.css';
import { InterfaceMotion } from '@/components/InterfaceMotion';
import { FilePreviewProvider } from '@/components/FilePreviewProvider';
import { NavigationLoading } from '@/components/NavigationLoading';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ThemeProvider } from '@/theme/ThemeProvider';
import './styles/foundation.css';

export const metadata: Metadata = {
  title: 'WebPilot',
  description: 'Persistent AI browser conversations and live browser control.',
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
            <FilePreviewProvider>
              <InterfaceMotion />
              {children}
              <NavigationLoading />
            </FilePreviewProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
