import type { Metadata } from "next";
import { ReactNode } from "react";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";

const title = "德州扑克 Equity 胜率计算器 · 范围 vs 手牌精确穷举 - 千算Poker";
const description =
  "PokerStove 语义的德州扑克胜率计算：手牌精确穷举、范围 Monte Carlo，支持 2–6 人底池，浏览器直算、免费无需注册。";

export const metadata: Metadata = zhPageMetadata({
  path: "/tools/odds",
  title,
  description,
  enPath: "/en/tools/odds",
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToolJsonLd
        path="/tools/odds"
        name="Equity 计算器"
        description={description}
      />
    </>
  );
}
