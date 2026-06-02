import type { Metadata } from 'next';
import { NavigationLoading } from '@/components/NavigationLoading';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Web Test',
  description: 'AI generated and executed browser test cases.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <NavigationLoading />
      </body>
    </html>
  );
}
