"use client";

/* ================================================================
   国庆靓牌速查 —— 扫描上传手牌中的「四条 / 同花顺 / 皇家同花顺」
   ------------------------------------------------------------
   命中条件（两条同时满足）：
   1. 用户在该手被发到牌且至少活到翻牌（sawFlop；翻前弃牌不算，翻前全押跑出去算）；
   2. 同桌任意玩家摊牌亮牌（`: shows [` 行）的最终牌型命中三类之一。

   只看第一条牌面：公牌直接取 ParsedHand.flopBoard/turnBoard/riverBoard
   （解析器口径：RIT 第二/三条牌面记在 *Board2/3，天然不参与）。

   GG 两种形态都天然覆盖，算法不读牌型描述、直接对「亮牌 2 张 +
   第一条公牌」做分类：
   - 普通手：shows 行带描述，但可能出现在任意街之后（全押提前亮牌，
     实测 45 万+ 条 shows 行分布在各街，并非只在 SHOWDOWN 段）；
   - 跑两次手：shows 行无描述、出现在发牌段之前（如 HD2999157910），
     SECOND SHOWDOWN 段没有 shows 行，不会重复计入。
   CoinPoker 牌谱不参加本次活动（用户口径：只考虑 GG），但转译后的
   shows 行结构相同，算法同样适用。
   ================================================================ */

import { useEffect, useMemo, useState } from "react";
import type { ParsedHand } from "@/lib/hhTypes";
import HandReplayModal, { type ReplayRowData } from "./HandReplayModal";
import { stampDate } from "./handReplay";

export type MonsterCategory = "皇家同花顺" | "同花顺" | "四条";

export interface MonsterHit {
  handId: string;
  holder: string;   // 亮出靓牌的玩家昵称（可能是用户自己）
  category: MonsterCategory;
}

// 展示排序：皇家 > 同花顺 > 四条；同类内保持上传时的时间序
const CATEGORY_ORDER: readonly MonsterCategory[] = ["皇家同花顺", "同花顺", "四条"];
// 徽标 CSS 修饰符（类别是中文，类名走 ASCII 映射）
const BADGE_MOD: Record<MonsterCategory, string> = {
  "皇家同花顺": "royal",
  "同花顺": "sf",
  "四条": "quads",
};

const SHOWS_RE = /^(\S+): shows \[([^\]]+)\]/gm;
const RANK_ORDER = "23456789TJQKA"; // index+2 = 牌力 2..14
const ROYAL = [10, 11, 12, 13, 14];

// 亮牌 2 张 + 公牌（3-5 张）→ 命中分类或 null。
// 7 张牌里四条与同花顺互斥（四条占 4 张异花色，剩 3 张凑不出同花顺），
// 判定顺序无所谓；同花顺判定用同花色 rank 集合查 5 连（含 A-5 钢轮）。
export function classifyMonster(hole: string[], board: string[]): MonsterCategory | null {
  const rankCount = new Map<number, number>();
  const bySuit = new Map<string, Set<number>>();
  for (const card of [...hole, ...board]) {
    const r = RANK_ORDER.indexOf(card[0]) + 2;
    const s = card[1];
    if (r < 2 || !s) continue; // 脏行容错：不是合法牌就跳过
    rankCount.set(r, (rankCount.get(r) ?? 0) + 1);
    let ranks = bySuit.get(s);
    if (!ranks) { ranks = new Set(); bySuit.set(s, ranks); }
    ranks.add(r);
  }
  for (const n of rankCount.values()) {
    if (n >= 4) return "四条";
  }
  for (const ranks of bySuit.values()) {
    if (ranks.size < 5) continue;
    if (ROYAL.every((r) => ranks.has(r))) return "皇家同花顺";
    for (let hi = 14; hi >= 6; hi--) {
      if (ranks.has(hi) && ranks.has(hi - 1) && ranks.has(hi - 2) && ranks.has(hi - 3) && ranks.has(hi - 4)) {
        return "同花顺";
      }
    }
    if (ranks.has(14) && ranks.has(5) && ranks.has(4) && ranks.has(3) && ranks.has(2)) return "同花顺";
  }
  return null;
}

// 扫描全部上传手牌（不受左栏筛选影响），返回命中列表（可能为空）。
// 纯字符串扫描：每手一次正则 + 一次小分类，几万手毫秒级。
export function findMonsterHands(hands: ParsedHand[]): MonsterHit[] {
  const hits: MonsterHit[] = [];
  const seen = new Set<string>(); // (handId, holder) 去重，防同一玩家重复亮牌行
  for (const h of hands) {
    if (!h.heroCards || !h.sawFlop) continue; // 没发到牌 / 翻前弃牌 = 不算（sawFlop=发了翻牌且 hero 非 folded before Flop）
    // turnBoard/riverBoard 是累计字段（river=flop+turn+river 全部），
    // 取非空最深一条即完整的第一条公牌；RIT 的第二/三条牌面在 *Board2/3，天然不掺入
    const board = (h.riverBoard || h.turnBoard || h.flopBoard).split(/\s+/).filter(Boolean);
    if (board.length < 3) continue; // 没发公牌不可能有摊牌牌型
    SHOWS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SHOWS_RE.exec(h.raw))) {
      const category = classifyMonster(m[2].trim().split(/\s+/), board);
      if (!category) continue;
      const key = `${h.id}\u0000${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ handId: h.id, holder: m[1], category });
    }
  }
  return hits.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
}

export default function MonsterHandsModal({
  open,
  onClose,
  hits,
  hands,
  scanned,
}: {
  open: boolean;
  onClose: () => void;
  hits: MonsterHit[];
  hands: ParsedHand[];   // 全量手牌，供回放按钮按 handId 取该手原文
  scanned: number;
}) {
  // 用命中列表下标（而非 handId）记当前回放：同一手可能被两名玩家同时亮牌命中，
  // 下标让 ‹ › 翻页严格沿列表顺序走
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  // 弹窗关闭时顺手清掉回放态，避免重开后残留上一次的回放层
  useEffect(() => {
    if (!open) setReplayIdx(null);
  }, [open]);

  const handById = useMemo(() => new Map(hands.map((h) => [h.id, h])), [hands]);
  const replayHit = replayIdx != null ? hits[replayIdx] ?? null : null;
  const replayHand = replayHit ? handById.get(replayHit.handId) ?? null : null;
  const replayRow: ReplayRowData | null = replayHand
    ? { raw: replayHand.raw, time: stampDate(replayHand.date), stakes: replayHand.stakes, pot: replayHand.potTotal, cards: replayHand.heroCards }
    : null;
  const goReplay = (delta: number) => {
    if (replayIdx == null) return;
    const ni = replayIdx + delta;
    if (ni < 0 || ni >= hits.length) return;
    setReplayIdx(ni);
  };

  if (!open) return null;
  return (
    <>
      <div className="b2rp-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          className="b2rp-panel ban2-monster-panel"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="国庆靓牌速查"
        >
          <div className="b2rp-head">
            <span className="b2rp-title">国庆靓牌速查</span>
            <span className="b2rp-meta">
              扫描 {scanned.toLocaleString()} 手 · 命中 {hits.length} 手
            </span>
            <button type="button" className="b2rp-close" onClick={onClose} aria-label="关闭">×</button>
          </div>
          {hits.length === 0 ? (
            <div className="ban2-monster-empty">
              <div className="ban2-monster-empty-icon" aria-hidden="true">♠</div>
              <div className="ban2-monster-empty-title">没有找到</div>
            <div className="ban2-monster-empty-sub">
              这批牌谱里没有「你见到翻牌 + 摊牌亮出四条 / 同花顺 / 皇家同花顺」的牌局
            </div>
            </div>
          ) : (
            <div className="ban2-monster-body">
              <table className="ban2-monster-table">
                <thead>
                  <tr>
                    <th>牌局编号</th>
                    <th>最终牌型</th>
                    <th>持有者</th>
                    <th className="ban2-monster-replay-col">回放</th>
                  </tr>
                </thead>
                <tbody>
                  {hits.map((hit, i) => (
                    <tr key={`${hit.handId}-${hit.holder}`}>
                      <td className="ban2-monster-id">{hit.handId}</td>
                      <td>
                        <span className={`ban2-monster-badge ban2-monster-badge--${BADGE_MOD[hit.category]}`}>
                          {hit.category}
                        </span>
                      </td>
                      <td className="ban2-monster-holder">{hit.holder}</td>
                      <td>
                        <button
                          type="button"
                          className="ban2-monster-replay-btn"
                          onClick={() => setReplayIdx(i)}
                          aria-label={`回放 ${hit.handId}`}
                        >▶ 回放</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* 节日落款小字（命中列表与空态都在面板底部显示） */}
          <div className="ban2-monster-foot">梅小板：国庆快乐同学们！千算比你还懂你的需求！</div>
        </div>
      </div>
      {/* 回放层渲染在靓牌弹窗之后（同为 b2rp-mask，DOM 序靠后者盖在上层）；关闭回到靓牌列表 */}
      {replayRow ? (
        <HandReplayModal
          row={replayRow}
          onClose={() => setReplayIdx(null)}
          posLabel={replayIdx != null ? `${replayIdx + 1} / ${hits.length}` : undefined}
          hasPrev={replayIdx != null && replayIdx > 0}
          hasNext={replayIdx != null && replayIdx < hits.length - 1}
          onPrev={() => goReplay(-1)}
          onNext={() => goReplay(1)}
        />
      ) : null}
    </>
  );
}
