import type { Metadata } from "next";
import { ReactNode } from "react";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";

const title = "德州翻前范围表 · GTO 开牌范围与频率 EV - 千算Poker";
const description =
  "GG Zoom 现金桌翻前 GTO 全树：先手开牌、面对加注、3bet / 4bet 与全压范围，13×13 矩阵看每手频率与 EV，免费在线查阅。";

export const metadata: Metadata = zhPageMetadata({
  path: "/tools/preflop",
  title,
  description,
  enPath: "/en/tools/preflop",
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToolJsonLd
        path="/tools/preflop"
        name="翻前范围表"
        description={description}
      />
    </>
  );
}
