import type { Metadata } from "next";
import type { ReactNode } from "react";

// 会员中心：个性化页——noindex、不进 sitemap
export const metadata: Metadata = {
  title: "会员中心 - BanSolver",
  description: "我的会员中心：云存储用量、账号与安全设置。",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
