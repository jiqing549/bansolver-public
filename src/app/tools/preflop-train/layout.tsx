import type { Metadata } from "next";
import { ReactNode } from "react";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";

const title = "德州扑克翻前训练 · GTO 开牌/3B/4B 决策随机出题 - 千算Poker";
const description =
  "从 GG Zoom / 红包桌 / 9MAX 五套 GTO 翻前解算树随机出题：按位置、对手与行动档位训练开牌、3-bet、4-bet 决策，作答即判频率契合度，浏览器直跑、免费无需注册。";

export const metadata: Metadata = zhPageMetadata({
  path: "/tools/preflop-train",
  title,
  description,
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToolJsonLd
        path="/tools/preflop-train"
        name="翻前训练"
        description={description}
      />
    </>
  );
}
