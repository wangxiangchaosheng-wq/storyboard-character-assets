import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: '史境 · 历史人物对话故事板',
  description: '与历史人物对话，让讨论中的关键场景自动化为同风格故事画面。',
  openGraph: {
    title: '史境 · 历史人物对话故事板',
    description: '与历史人物对话，让讨论中的关键场景自动化为同风格故事画面。',
    images: [{ url: '/character-reference.png', width: 1920, height: 1080 }],
    locale: 'zh_CN',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: '史境 · 历史人物对话故事板',
    description: '与历史人物对话，让讨论中的关键场景自动化为同风格故事画面。',
    images: ['/character-reference.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
