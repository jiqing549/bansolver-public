import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bansolver.com"),
  title: "千算Poker BanSolver · 免费德州扑克工具站：牌谱复盘 · 范围表 · 方差",
  description:
    "数据驱动的免费德州扑克工具站：GG 牌谱复盘、翻前 GTO 范围表、胜率与方差计算器、扑克番茄钟，浏览器直接运行，无需注册。",
  alternates: {
    canonical: "/",
    languages: { "zh-CN": "/", en: "/en", "x-default": "/en" },
  },
  openGraph: {
    title: "千算Poker BanSolver · 免费德州扑克工具站",
    description: "GG 牌谱复盘、翻前范围表、胜率与方差计算器，浏览器直接运行，无需注册。",
    url: "/",
    type: "website",
    siteName: "BanSolver",
    locale: "zh_CN",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "千算Poker BanSolver · 免费德州扑克工具站",
    description: "GG 牌谱复盘、翻前范围表、胜率与方差计算器，浏览器直接运行，无需注册。",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <div className="noise-overlay" aria-hidden="true" />
        <div className="brand-fixed-mark" aria-hidden="true">
          <img src="/brand/qiansuan-mark.svg" alt="" />
        </div>
        {children}
      </body>
    </html>
  );
}
