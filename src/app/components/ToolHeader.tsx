import Link from "next/link";
import ToolGlyph from "./ToolGlyph";
import type { GlyphName } from "./tools";

/**
 * 工具页统一页头：分类小标 + 标题 + 说明 + 品牌水印 + 回到工具台。
 * 让六个工具页共享同一套入口节奏，而不是每页各写一份内联标题。
 * actions：可选的操作按钮插槽（如翻前训练入口），贴着右下角排布，不传不影响其他工具页。
 */
export default function ToolHeader({
  kicker,
  title,
  desc,
  glyph,
  backLabel,
  backHref,
  actions,
}: {
  kicker: string;
  title: string;
  desc?: React.ReactNode;
  glyph: GlyphName;
  backLabel?: string;
  backHref?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="tool-head">
      <div className="tool-head-copy">
        <p className="tool-head-kicker">{kicker}</p>
        <h1 className="tool-head-title">{title}</h1>
        {desc ? <p className="tool-head-desc">{desc}</p> : null}
      </div>
      {actions ? <div className="tool-head-actions">{actions}</div> : null}
      <span className="tool-head-mark" aria-hidden="true">
        <ToolGlyph name={glyph} />
      </span>
      <Link href={backHref ?? "/"} className="tool-head-back">
        {backLabel ?? "← 工具台"}
      </Link>
    </header>
  );
}
