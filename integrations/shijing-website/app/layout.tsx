import type { Metadata } from 'next';
import './globals.css';
import LocaleLangSync from './components/LocaleLangSync';
import { DEFAULT_LOCALE } from './lib/i18n';

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
    // SSR 快照固定为 DEFAULT_LOCALE（服务端读不到本机存储）；挂载后
    // LocaleLangSync 按玩家选择改成 zh-CN / en——首屏与水合快照一致，无偏差。
    <html lang={DEFAULT_LOCALE}>
      <body>{children}<LocaleLangSync/></body>
    </html>
  );
}
