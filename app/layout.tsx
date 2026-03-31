/**
 * @file 应用根布局
 * @description 全局 HTML 骨架，设置语言、PWA manifest、Service Worker 注册和全局样式
 */
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "ChatBot",
  title: "Provider-style Web Channel",
  description:
    "Authenticated multi-panel web channel with uploads, streaming, and passive provider delivery.",
  icons: {
    icon: "/favicon.jpg",
    shortcut: "/favicon.jpg",
    apple: "/favicon.jpg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "ChatBot",
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

/**
 * 根布局组件
 * @description 渲染 html/body 标签，注入 manifest 链接和 Service Worker 脚本。
 * @param props - 包含 children 子组件
 * @returns 完整的 HTML 文档结构
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link
          rel="manifest"
          href="/app-manifest.webmanifest"
          crossOrigin="use-credentials"
        />
      </head>
      <body className="antialiased">
        {children}
        <Script src="/register-sw.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};
