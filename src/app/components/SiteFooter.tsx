"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ToolGlyph from "./ToolGlyph";
import { NAV_TOOLS } from "./tools";
import { langSwitch } from "./langSwitch";

/** 工具页统一页脚：品牌 + 工具索引 + 语言切换 + 回工具台。 */
export default function SiteFooter({ note }: { note?: string }) {
  const pathname = usePathname() || "";
  const lang = langSwitch(pathname);
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-top">
          <Link href="/" className="site-footer-brand">
            <span className="navbar-mark" aria-hidden="true">
              <img src="/brand/qiansuan-mark.svg" alt="" />
            </span>
            <span className="site-footer-brand-text">
              <b>千算Poker免费工具站</b>
              <i>BanSolver.com</i>
            </span>
          </Link>

          <nav className="site-footer-nav" aria-label="工具索引">
            {NAV_TOOLS.map((t) => (
              <Link key={t.href} href={t.href}>
                <ToolGlyph name={t.glyph} />
                {t.title}
              </Link>
            ))}
            <Link href="/guide">攻略 · FAQ</Link>
            <Link href={lang.href} title={lang.toEn ? "Switch to English" : "切换到中文"}>
              {lang.toEn ? "English" : "中文"}
            </Link>
          </nav>
        </div>

        <div className="site-footer-bottom">
          <p>
            © {new Date().getFullYear()} BanSolver · 梅小板联系微信 muston549 欢迎提建议找bug
            {note ? ` · ${note}` : ""}
          </p>
          <Link href="/" className="site-footer-back">
            回到工具台 ↑
          </Link>
        </div>
      </div>
    </footer>
  );
}
