import type { Metadata } from "next";
import { ReactNode } from "react";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";

const title = "扑克人生模拟器 · 德州牌手生涯模拟游戏 - 千算Poker";
const description =
  "18 项天赋、110+ 事件、15+ 结局：从 grinder 到 legend，模拟德州扑克职业牌手的一生。免费网页游戏，无需下载。";

export const metadata: Metadata = zhPageMetadata({
  path: "/tools/lifesim",
  title,
  description,
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToolJsonLd
        path="/tools/lifesim"
        name="扑克人生模拟"
        description={description}
        applicationCategory="GameApplication"
      />
    </>
  );
}
