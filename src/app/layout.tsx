import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Web Test',
  description: 'AI generated and executed browser test cases.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
