import type { Metadata } from "next";
import { ReactNode } from "react";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";

const title = "GG牌谱复盘工具 Ban2Note · GGPoker 牌谱数据分析 - 千算Poker";
const description =
  "把 GGPoker / CoinPoker 牌谱拖进浏览器：盈亏曲线、位置统计、胜负手与去重报告秒出，本地解析不上传，免费无需注册。";

export const metadata: Metadata = zhPageMetadata({
  path: "/tools/ban2note",
  title,
  description,
  enPath: "/en/tools/ban2note",
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToolJsonLd
        path="/tools/ban2note"
        name="Ban2Note 数据复盘"
        description={description}
      />
    </>
  );
}
