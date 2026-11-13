import type { Metadata } from "next";
import { ReactNode } from "react";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";

const title = "扑克番茄钟 · 专注计时与防上头 - 千算Poker";
const description =
  "为牌桌设计的番茄钟：专注块加强制休息，每块记一句手感，到上限自动喊停，帮你在长 session 里保持状态。免费在线使用。";

export const metadata: Metadata = zhPageMetadata({
  path: "/tools/pomodoro",
  title,
  description,
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToolJsonLd
        path="/tools/pomodoro"
        name="扑克番茄钟"
        description={description}
      />
    </>
  );
}
