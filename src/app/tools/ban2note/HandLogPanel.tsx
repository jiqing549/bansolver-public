"use client";

/* ================================================================
   查看牌谱 — 逐手牌谱表 + 单手回放
   ================================================================
   每行一手：时间 / 位置 / 起手牌 / 底池人数 / 翻牌前的行动缩写 /
   翻牌·转牌·河牌各街的「行动 + 新发公共牌 + 街初底池」/ 级别 /
   底池 (bb) / 净盈利 (bb)。

   排序：按时间 / 按净盈利 / 按底池（快速按钮），底池与净盈利列头
   可再点切升降序；快速筛选：全部 / 盈利 / 亏损 / 摊牌；
   每页 30 手，「显示更多」每次 +50；点击任意一行弹出该手回放。
   ================================================================ */

import { useMemo, useState } from "react";
import type { ParsedHand } from "@/lib/hhTypes";
import {
  amountToBB,
  flopPlayersCount,
  handNetBB,
  handTimestamp,
  noFlopActiveHand,
  parseHandForReplayCached,
  stampDate,
  type ReplayStreet,
} from "./handReplay";
import HandReplayModal, { type ReplayRowData } from "./HandReplayModal";

interface Props {
  hands: ParsedHand[];
}

interface HandLogRow {
  key: string;
  date: string;
  time: string;
  pos: string;
  cards: string;
  stakes: string;
  pot: number;
  net: number; // 水后净盈利（bb）
  bb: number;
  raw: string;
  flopLabel: string; // 底池人数（2~6 / 无翻牌 / —）
  showdown: boolean;
}

type SortKey = "time" | "net" | "pot";
type QuickFilter = "all" | "win" | "lose" | "sd";

function buildRows(hands: ParsedHand[], sort: SortKey, filter: QuickFilter, dir: "asc" | "desc"): HandLogRow[] {
  const rows: HandLogRow[] = [];
  for (const h of hands) {
    if (filter === "win" && !(h.heroWon > 0)) continue;
    if (filter === "lose" && h.heroWon > 0) continue;
    if (filter === "sd" && !h.showdown) continue;
    const fp = flopPlayersCount(h.raw || "");
    const flopLabel = fp > 0 ? String(fp) : noFlopActiveHand(h) ? "无翻牌" : "—";
    const bb = parseFloat((h.stakes || "").split("/")[1] || "") || 0;
    rows.push({
      key: h.id || `h${rows.length}`,
      date: h.date || "",
      time: stampDate(h.date),
      pos: h.heroPosition || "—",
      cards: h.heroCards || "",
      stakes: h.stakes || "—",
      pot: h.potTotal || 0,
      net: handNetBB(h),
      bb,
      raw: h.raw || "",
      flopLabel,
      showdown: !!h.showdown,
    });
  }
  rows.sort((a, b) => {
    if (sort === "time") {
      // 坏日期（handTimestamp 返回 +Infinity）恒沉底，避免升降序取负后浮顶、以及 Infinity-Infinity=NaN 破坏比较器
      const ta = handTimestamp(a.date);
      const tb = handTimestamp(b.date);
      const fa = Number.isFinite(ta);
      const fb = Number.isFinite(tb);
      if (fa && fb) return -(ta - tb); // 时间列固定新→旧
      if (fa) return -1;
      if (fb) return 1;
      return 0;
    }
    const diff = sort === "net" ? a.net - b.net : a.pot - b.pot;
    // 金额列按升降序切换
    return dir !== "asc" ? -diff : diff;
  });
  return rows;
}

function fmtNet(v: number): string {
  const n = Math.round(v * 10) / 10;
  return (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(n);
}

function netCls(v: number): string {
  return v >= 0 ? " ban2note-hands-up" : " ban2note-hands-down";
}

const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** 起手牌四色着色（黑桃灰 / 红桃红 / 梅花绿 / 方块蓝） */
function HeroCards({ text }: { text: string }) {
  const cards = (text || "").trim().split(/\s+/).filter(Boolean);
  return (
    <>
      {cards.map((c, i) => {
        const suit = c.length >= 2 ? c.charAt(c.length - 1).toLowerCase() : "";
        const rank = c.length >= 2 ? c.slice(0, -1) : c;
        const color =
          suit === "h" ? " b2-card--red" :
          suit === "c" ? " b2-card--green" :
          suit === "d" ? " b2-card--blue" : "";
        return <span key={`${c}-${i}`} className={"b2-card" + color}>{rank}{SUITS[suit] || ""}</span>;
      })}
    </>
  );
}

/** 公共牌小芯片（四色底） */
function BoardChips({ text }: { text: string }) {
  const cards = (text || "").trim().split(/\s+/).filter(Boolean);
  return (
    <>
      {cards.map((c, i) => {
        const suit = c.length >= 2 ? c.charAt(c.length - 1).toLowerCase() : "";
        const rank = c.length >= 2 ? c.slice(0, -1) : c;
        return (
          <span key={`${c}-${i}`} className={`b2hl-cd${suit ? ` b2hl-cd--${suit}` : ""}`}>
            {rank}{SUITS[suit] || ""}
          </span>
        );
      })}
    </>
  );
}

// 行动明细缩写：X 过牌 / B 下注 / R 加注到 / C 跟注 / F 弃牌，金额一律换算为 BB
const POS_COLORS: Record<string, string> = {
  SB: "#eab308", BB: "#3b82f6", UTG: "#22c55e", "UTG+1": "#ef4444", "UTG+2": "#a855f7",
  MP: "#14b8a6", HJ: "#ec4899", CO: "#84cc16", BTN: "#a1a1aa",
};
const ACT_COLOR_ALT = ["#3b82f6", "#eab308", "#22c55e", "#ef4444", "#a855f7", "#f97316"];

function actLetter(kind: string): string {
  if (kind === "check") return "X";
  if (kind === "fold") return "F";
  if (kind === "bet") return "B";
  if (kind === "raise") return "R";
  if (kind === "call") return "C";
  return "";
}

function tokAmount(amt: number, bb: number): string {
  if (!(bb > 0)) return "";
  const n = Math.round((amt / bb) * 10) / 10;
  return String(Math.round(n * 100) / 100).replace(/\.0+$/, "");
}

/** 一手牌的 10 个街道单元格：翻前行动 / [翻牌牌面 · 底池 · 行动]×3 */
function streetCells(row: HandLogRow) {
  const parsed = parseHandForReplayCached(row.raw);
  const bb = row.bb;
  const byKey: Record<string, ReplayStreet> = {};
  if (parsed) {
    for (const st of parsed.streets) byKey[st.key] = st;
  }
  const toks = (key: string) => {
    const st = byKey[key];
    const out: { t: string; c: string; hero: boolean }[] = [];
    if (!st) return out;
    st.acts.forEach((a, j) => {
      if (a.kind === "post" || a.kind === "collect") return;
      const l = actLetter(a.kind);
      if (!l) return;
      out.push({
        t: l + (l === "X" || l === "F" ? "" : tokAmount(a.amt, bb)),
        c: POS_COLORS[a.pos] || ACT_COLOR_ALT[j % ACT_COLOR_ALT.length],
        hero: !!a.isHero,
      });
    });
    return out;
  };
  const potOf = (key: string) => {
    const st = byKey[key];
    return st && st.potBefore > 0 && bb > 0 ? amountToBB(st.potBefore, bb) : "";
  };
  const boardOf = (key: string) => byKey[key]?.boardNew || "";
  const board2Of = (key: string) => byKey[key]?.board2New || "";
  const board3Of = (key: string) => byKey[key]?.board3New || "";
  const actCell = (list: { t: string; c: string; hero: boolean }[], key: string) => (
    <td key={key} className="ban2note-hands-actcol">
      {list.map((x, i) => (
        <span key={`${key}-${i}`} className={"b2hl-tok" + (x.hero ? " b2hl-tok--hero" : "")} style={{ color: x.c }}>
          {x.t}
        </span>
      ))}
    </td>
  );
  // 跑两次的手第二行以 ② 前缀叠放第二条牌面（跑三次再叠 ③），与主牌面同列
  const boardCell = (v: string, v2: string, v3: string, key: string) => (
    <td key={key} className="ban2note-hands-actcol">
      {v ? <BoardChips text={v} /> : ""}
      {v2 ? (
        <span className="ban2note-hands-board2">
          <span className="ban2note-hands-board2-tag">②</span>
          <BoardChips text={v2} />
        </span>
      ) : ""}
      {v3 ? (
        <span className="ban2note-hands-board2">
          <span className="ban2note-hands-board2-tag">③</span>
          <BoardChips text={v3} />
        </span>
      ) : ""}
    </td>
  );
  const potCell = (v: string, key: string) => <td key={key}>{v}</td>;
  return [
    actCell(toks("preflop"), "pre"),
    boardCell(boardOf("flop"), board2Of("flop"), board3Of("flop"), "fc"),
    potCell(potOf("flop"), "fp"),
    actCell(toks("flop"), "fa"),
    boardCell(boardOf("turn"), board2Of("turn"), board3Of("turn"), "tc"),
    potCell(potOf("turn"), "tp"),
    actCell(toks("turn"), "ta"),
    boardCell(boardOf("river"), board2Of("river"), board3Of("river"), "rc"),
    potCell(potOf("river"), "rp"),
    actCell(toks("river"), "ra"),
  ];
}

const PAGE_SIZE = 30;
const PAGE_STEP = 50;

export default function HandLogPanel({ hands }: Props) {
  const [sort, setSort] = useState<SortKey>("time");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState<QuickFilter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selKey, setSelKey] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(hands, sort, filter, dir), [hands, sort, filter, dir]);
  const selRow = selKey ? rows.find((r) => r.key === selKey) ?? null : null;
  // 回放翻页序号：跟随当前排序+筛选后的列表顺序
  const selIdx = selKey ? rows.findIndex((r) => r.key === selKey) : -1;

  const goReplay = (delta: number) => {
    if (selIdx < 0) return;
    const ni = selIdx + delta;
    if (ni < 0 || ni >= rows.length) return;
    setSelKey(rows[ni].key);
    // 翻到还没「显示更多」出来的行时自动扩表，保证高亮行可见
    setLimit((n) => (ni >= n ? ni + 1 : n));
  };

  // 可排序列头：点一次按此列降序，再点同列切升降序
  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir("desc");
    }
  };

  const replayRow: ReplayRowData | null = selRow
    ? { raw: selRow.raw, time: selRow.time, stakes: selRow.stakes, pot: selRow.pot, cards: selRow.cards }
    : null;

  const sortColumns: { label: string; key?: SortKey }[] = [
    { label: "时间" },
    { label: "位置" },
    { label: "起手牌" },
    { label: "底池人数" },
    { label: "行动" },
    { label: "翻牌" },
    { label: "底池" },
    { label: "行动" },
    { label: "T." },
    { label: "底池" },
    { label: "行动" },
    { label: "R." },
    { label: "底池" },
    { label: "行动" },
    { label: "级别" },
    { label: "底池 (bb)", key: "pot" },
    { label: "净盈利 (bb)", key: "net" },
  ];

  return (
    <div className="ban2note-hands">
      <div className="card ban2note-hands-block">
        <div className="ban2note-hands-head">
          <p className="ban2note-hands-title">
            查看牌谱（感谢群友 信念🔥 贡献的代码）
            <span className="ban2note-hands-title-sub">共 {rows.length} 手</span>
          </p>
          <div className="ban2note-hands-filters">
            <div className="ban2note-hand-sorts">
              {([
                { key: "time", label: "按时间" },
                { key: "net", label: "按净盈利" },
                { key: "pot", label: "按底池" },
              ] as { key: SortKey; label: string }[]).map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={"ban2note-hand-sort" + (sort === s.key ? " ban2note-hand-sort--active" : "")}
                  onClick={() => {
                    setSort(s.key);
                    setDir("desc");
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="ban2note-hand-sorts">
              {([
                { key: "all", label: "全部" },
                { key: "win", label: "盈利" },
                { key: "lose", label: "亏损" },
                { key: "sd", label: "摊牌" },
              ] as { key: QuickFilter; label: string }[]).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={"ban2note-hand-sort" + (filter === f.key ? " ban2note-hand-sort--active" : "")}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="ban2note-hands-hint">点击任意一行，弹出该手牌的回放：牌桌位置与逐街行动路线；弹窗内用 ← → 方向键或两侧 ‹ › 按钮按当前排序顺序翻看上一手 / 下一手，点 ▶（或 Space）逐动作播放，桌面跟随当前动作、路线区当前步高亮。</p>

        {rows.length === 0 ? (
          <p className="ban2note-hands-empty">当前筛选下没有牌谱</p>
        ) : (
          <table className="ban2note-hands-table ban2note-hands-table--hands">
            <thead>
              <tr>
                {sortColumns.map((col, i) =>
                  col.key ? (
                    <th
                      key={`c${i}`}
                      className={"ban2note-hands-thsort" + (sort === col.key ? " ban2note-hands-thsort--active" : "")}
                      aria-sort={sort === col.key ? (dir === "asc" ? "ascending" : "descending") : "none"}
                      title="点击切换升序 / 降序"
                      tabIndex={0}
                      onClick={() => toggleSort(col.key!)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleSort(col.key!);
                        }
                      }}
                    >
                      {col.label}
                      <span className="ban2note-hands-thsort-arrow">
                        {sort === col.key ? (dir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </th>
                  ) : (
                    <th key={`c${i}`}>{col.label}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((r) => (
                <tr
                  key={r.key}
                  className={"ban2note-hands-row" + (selKey === r.key ? " ban2note-hands-row--active" : "")}
                  onClick={() => setSelKey(r.key)}
                >
                  <td>{r.time}</td>
                  <td>{r.pos}</td>
                  <td className="ban2note-hand-cards">{r.cards ? <HeroCards text={r.cards} /> : "—"}</td>
                  <td>{r.flopLabel}</td>
                  {streetCells(r)}
                  <td>{r.stakes}</td>
                  <td>{r.bb > 0 ? amountToBB(r.pot, r.bb) : "—"}</td>
                  <td className={"ban2note-hands-num" + netCls(r.net)}>{fmtNet(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rows.length > limit ? (
          <div className="ban2note-hands-listbar">
            <span>已显示 {limit} / {rows.length} 手</span>
            <button type="button" className="ban2note-hands-more" onClick={() => setLimit((n) => n + PAGE_STEP)}>
              显示更多
            </button>
          </div>
        ) : null}
      </div>

      <p className="ban2note-hands-note">
        净盈利为「水后」口径：已扣除游戏抽水与 JP 抽水，并计入全下保险的收支后换算为 BB（筹码 ÷ 大盲）；底池为全场收池合计；「翻牌 / T. / R.」为各街新发出的公共牌（花色按四色牌着色），跑两次的全押手牌第二行以 ② 前缀叠放第二条牌面，其后的「底池」为该街开始时的底池。行动明细按「X 过牌 / B 下注 / R 加注到 / C 跟注 / F 弃牌」缩写并附金额（BB），文字颜色区分玩家，带下划线的为 Hero 自己的行动。默认展示 30 手，可用筛选与「显示更多」逐段回看；「底池人数」列为该手有多少人进入翻牌圈（翻前没有弃牌的入池玩家数）；没发出翻牌、但 Hero 翻前主动投入过筹码（跟注 / 加注 / 下注，盲注不算）的牌局记为「无翻牌」，其余未发出翻牌的牌局记为「—」；点击「底池 (bb)」「净盈利 (bb)」列头可在升序 / 降序之间切换；点击任意一行可弹出该手牌的回放，回放弹窗内可用 ← → 方向键或两侧按钮按当前排序顺序翻看，翻到未显示的手会自动扩表；也可点 ▶（或 Space）逐动作播放本手：行动路线全程完整保留，当前动作在路线区金色高亮、行动者座位在牌桌上同步亮圈，公共牌逐街翻开、桌面底池实时累计，对手底牌与 WIN 到收池才亮，点任意动作可跳到那一步（未播放时点击即从该步开始播放）。
      </p>

      {replayRow ? (
        <HandReplayModal
          row={replayRow}
          onClose={() => setSelKey(null)}
          posLabel={selIdx >= 0 ? `${selIdx + 1} / ${rows.length}` : undefined}
          hasPrev={selIdx > 0}
          hasNext={selIdx >= 0 && selIdx < rows.length - 1}
          onPrev={() => goReplay(-1)}
          onNext={() => goReplay(1)}
        />
      ) : null}
    </div>
  );
}
