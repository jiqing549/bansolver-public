/* ==============================================================
   语言切换：zh ↔ en 页面对照（仅这六组有英文版，
   其余中文页切英文时落到 /en 英文首页）
   顶栏不放语言入口；入口在页脚（SiteFooter / 首页 / ban2note）。
   ============================================================== */
const LANG_PAIRS: Record<string, string> = {
  "/": "/en",
  "/guide": "/en/guide",
  "/tools/ban2note": "/en/tools/ban2note",
  "/tools/odds": "/en/tools/odds",
  "/tools/preflop": "/en/tools/preflop",
};

export function langSwitch(pathname: string): { href: string; toEn: boolean } {
  /* 英文页必有中文对应版：剥掉 /en 前缀即可（必须精确匹配，preflop≠preflop-train） */
  if (pathname === "/en" || pathname.startsWith("/en/")) {
    return { href: pathname.slice(3) || "/", toEn: false };
  }
  return { href: LANG_PAIRS[pathname] ?? "/en", toEn: true };
}
