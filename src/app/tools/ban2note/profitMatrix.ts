/* ================================================================
   盈利矩阵 — 起手牌组合维度聚合（纯逻辑，无 React）
   ================================================================
   把筛选后的手牌按「起手牌组合」（AKs / AKo / AA …，同花色合并花色）
   聚合成四张表，供盈利矩阵面板使用：
     - aggregateByCombo        矩阵格：手数 / 净盈利 / 胜负 / 摊牌 / 见翻
     - aggPositionsByCombo     详情卡「按位置」：组合 × 位置
     - aggPreflopActionsByCombo 详情卡「翻前动作」：组合 × 7 项动作
     - handListByCombo         详情卡「逐手明细」：组合 → 逐手列表

   净盈利一律用水后口径 handNetBB（扣抽水与 JP、计入全下保险），
   大盲解析不出（stakes 异常）的手牌整手跳过。
   ================================================================ */

import type { ParsedHand } from "@/lib/hhTypes";
import { handNetBB } from "./handReplay";

const RANKS = "23456789TJQKA";

// 「As Kd」→「AKo」；对子返回「AA」；非法输入返回 null
export function comboLabel(heroCards: string): string | null {
  const cards = (heroCards || "").trim().split(/\s+/).filter(Boolean);
  if (cards.length !== 2) return null;
  const c1 = cards[0];
  const c2 = cards[1];
  if (c1.length < 2 || c2.length < 2) return null;
  const r1 = c1.charAt(0);
  const s1 = c1.slice(1);
  const r2 = c2.charAt(0);
  const s2 = c2.slice(1);
  if (RANKS.indexOf(r1) < 0 || RANKS.indexOf(r2) < 0) return null;
  if (r1 === r2) return r1 + r2;
  const hiFirst = RANKS.indexOf(r1) >= RANKS.indexOf(r2);
  return (hiFirst ? r1 + r2 : r2 + r1) + (s1 === s2 ? "s" : "o");
}

// 组合类别（详情卡头部的小标签）
export function comboCat(label: string): string {
  if (label.length === 2) return "口袋对";
  return label.charAt(label.length - 1) === "s" ? "同花" : "非同花";
}

/** 矩阵格聚合 */
export interface ComboAgg {
  key: string; // 组合名，如 AKs
  cat: string; // 口袋对 / 同花 / 非同花
  hands: number;
  net: number; // 水后净盈利合计（bb）
  won: number; // 赢下底池的手数
  show: number; // 进入摊牌的手数
  showWon: number; // 摊牌且赢的手数
  sawFlop: number;
}

export function aggregateByCombo(hands: ParsedHand[]): ComboAgg[] {
  const map = new Map<string, ComboAgg>();
  for (const h of hands) {
    const key = comboLabel(h.heroCards);
    if (!key) continue;
    const bb = parseFloat((h.stakes || "").split("/")[1] || "") || 0;
    if (!(bb > 0)) continue;
    const won = h.heroWon > 0;
    let agg = map.get(key);
    if (!agg) {
      agg = { key, cat: comboCat(key), hands: 0, net: 0, won: 0, show: 0, showWon: 0, sawFlop: 0 };
      map.set(key, agg);
    }
    agg.hands++;
    agg.net += handNetBB(h);
    if (won) agg.won++;
    if (h.sawFlop) agg.sawFlop++;
    if (h.showdown) {
      agg.show++;
      if (won) agg.showWon++;
    }
  }
  return [...map.values()];
}

/** 详情卡「按位置」：组合 → 位置 → 聚合 */
export type ComboPosMap = Map<string, Map<string, { key: string; hands: number; net: number; won: number }>>;

export function aggPositionsByCombo(hands: ParsedHand[]): ComboPosMap {
  const out: ComboPosMap = new Map();
  for (const h of hands) {
    const key = comboLabel(h.heroCards);
    if (!key) continue;
    const bb = parseFloat((h.stakes || "").split("/")[1] || "") || 0;
    if (!(bb > 0)) continue;
    let perCombo = out.get(key);
    if (!perCombo) {
      perCombo = new Map();
      out.set(key, perCombo);
    }
    const pos = h.heroPosition || "—";
    const row = perCombo.get(pos) || { key: pos, hands: 0, net: 0, won: 0 };
    row.hands++;
    row.net += handNetBB(h);
    if (h.heroWon > 0) row.won++;
    perCombo.set(pos, row);
  }
  return out;
}

/** 翻前动作 7 项：与详情卡表行顺序一致 */
export const PREFLOP_ACT_DEFS: { key: PreflopActKey; label: string }[] = [
  { key: "callOpen", label: "跟注 open" },
  { key: "three", label: "3B" },
  { key: "callThree", label: "跟注 3B" },
  { key: "four", label: "4B" },
  { key: "callFour", label: "跟注 4B" },
  { key: "allin", label: "ALLIN" },
  { key: "callAI", label: "跟注 ALLIN" },
];
export type PreflopActKey = "callOpen" | "three" | "callThree" | "four" | "callFour" | "allin" | "callAI";

export interface PreflopActCell {
  h: number; // 动作发生手数
  opp: number; // 机会手数
  net: number; // 动作发生那些手的水后净盈利合计（bb）
}

export interface ComboActAgg {
  hands: number;
  m: Record<PreflopActKey, PreflopActCell>;
}

// 翻前动作标记：主动全下 / 跟注全下 / 是否跟注过 取自本手 Hero 的翻前动作串；
// 「是否面对对手全下」需要回看原始牌谱（对手推出后 Hero 仍有行动，才算真的
// 面对过），故按 Dealt to 定位 Hero 后只扫翻前段，遇到第一条街标记即停。
function preflopActFlags(h: ParsedHand): { allinAgg: boolean; allinCall: boolean; called: boolean; facedAI: boolean } {
  const arr = (h && h.preflopActions) || [];
  let agg = false, cal = false, anyCall = false, faced = false;
  for (const raw of arr) {
    const a = String(raw || "").trim();
    if (/^calls\b/.test(a)) {
      anyCall = true;
      if (/all-in/.test(a)) cal = true;
    } else if (/^raises\b/.test(a) || /^bets\b/.test(a) || /^Bet & Muck\b/.test(a)) {
      if (/all-in/.test(a)) agg = true;
    }
  }
  const raw = String((h && h.raw) || "");
  const dm = raw.match(/Dealt to (.+?) \[/);
  if (dm) {
    const hero = dm[1];
    const lines = raw.split(/\r?\n/);
    let on = false;
    let pending = false;
    for (const rawLine of lines) {
      const s = rawLine.trim();
      if (!on) {
        if (/^Dealt to /.test(s)) on = true;
        continue;
      }
      if (/^\*\*\*\s/.test(s)) break;
      const m = s.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      if (m[1].trim() === hero) {
        if (pending) faced = true;
      } else if (/all-in/i.test(m[2])) {
        pending = true;
      }
    }
  }
  return { allinAgg: agg, allinCall: cal, called: anyCall, facedAI: faced };
}

/** 详情卡「翻前动作」：组合 → 7 项动作聚合 */
export function aggPreflopActionsByCombo(hands: ParsedHand[]): Map<string, ComboActAgg> {
  const out = new Map<string, ComboActAgg>();
  const mk = (): ComboActAgg => ({
    hands: 0,
    m: {
      callOpen: { h: 0, opp: 0, net: 0 },
      three: { h: 0, opp: 0, net: 0 },
      callThree: { h: 0, opp: 0, net: 0 },
      four: { h: 0, opp: 0, net: 0 },
      callFour: { h: 0, opp: 0, net: 0 },
      allin: { h: 0, opp: 0, net: 0 },
      callAI: { h: 0, opp: 0, net: 0 },
    },
  });
  for (const h of hands) {
    const key = comboLabel(h.heroCards);
    if (!key) continue;
    const bb = parseFloat((h.stakes || "").split("/")[1] || "") || 0;
    if (!(bb > 0)) continue;
    const nb = handNetBB(h);
    let agg = out.get(key);
    if (!agg) {
      agg = mk();
      out.set(key, agg);
    }
    agg.hands++;
    const f = preflopActFlags(h);
    const m = agg.m;
    const fo = !!h.facingRaise;
    const f3 = !!h.facingThreeBet;
    const f4 = !!h.facingFourBet;
    const ai = !!f.facedAI;
    const raiseOpp = fo || f3 || f4 ? 1 : 0;
    // 「跟注 open」= 面对单个加注时跟注，且没有把它再打成 3B / 4B。刻意不用
    // facedOpenRaiseAndCalled：那个标记在「Hero 先 3B、再跟注对手 4B」时也为真。
    m.callOpen.opp += fo ? 1 : 0;
    if (fo && !h.threeBet && !h.isFourBet && f.called) {
      m.callOpen.h++;
      m.callOpen.net += nb;
    }
    m.three.opp += fo ? 1 : 0;
    if (h.threeBet) {
      m.three.h++;
      m.three.net += nb;
    }
    m.callThree.opp += f3 ? 1 : 0;
    if (f3 && !h.foldedToThreeBet && !h.isFourBet) {
      m.callThree.h++;
      m.callThree.net += nb;
    }
    m.four.opp += f3 ? 1 : 0;
    if (h.isFourBet) {
      m.four.h++;
      m.four.net += nb;
    }
    m.callFour.opp += f4 ? 1 : 0;
    // hero 面对对手 4bet 后再加注（5bet+，无论是否全下）都不是「跟注 4B」
    if (f4 && !h.foldedToFourBet && !f.allinAgg && !h.isFiveBet) {
      m.callFour.h++;
      m.callFour.net += nb;
    }
    m.allin.opp += raiseOpp;
    if (f.allinAgg) {
      m.allin.h++;
      m.allin.net += nb;
    }
    m.callAI.opp += ai ? 1 : 0;
    if (f.allinCall) {
      m.callAI.h++;
      m.callAI.net += nb;
    }
  }
  // 兜底：冷 4B（未开池就 4B）等极端局面会让分子落在自然机会集之外，
  // 此时把机会数抬到分子，避免出现「1 / 0」这类读不通的读数；
  // 正常局面下这一步不改动任何数值。
  for (const agg of out.values()) {
    for (const k of Object.keys(agg.m) as PreflopActKey[]) {
      const cell = agg.m[k];
      if (cell.opp < cell.h) cell.opp = cell.h;
    }
  }
  return out;
}

/** 详情卡「逐手明细」行（点击可打开该手回放） */
export interface ComboHandItem {
  ord: number;
  id: string;
  date: string;
  pos: string;
  net: number; // 水后净盈利（bb）
  won: boolean;
  sd: boolean;
  raw: string;
  stakes: string;
  pot: number;
  cards: string;
  heroWon: boolean;
  time: string;
}

export function handListByCombo(hands: ParsedHand[]): Map<string, ComboHandItem[]> {
  const out = new Map<string, ComboHandItem[]>();
  for (const h of hands) {
    const key = comboLabel(h.heroCards);
    if (!key) continue;
    const bb = parseFloat((h.stakes || "").split("/")[1] || "") || 0;
    if (!(bb > 0)) continue;
    let list = out.get(key);
    if (!list) {
      list = [];
      out.set(key, list);
    }
    list.push({
      ord: list.length,
      id: h.id || "",
      date: h.date || "",
      pos: h.heroPosition || "—",
      net: handNetBB(h),
      won: h.heroWon > 0,
      sd: !!h.showdown,
      raw: h.raw || "",
      stakes: h.stakes || "—",
      pot: h.potTotal || 0,
      cards: h.heroCards || "",
      heroWon: h.heroWon > 0,
      time: "",
    });
  }
  // 按日期倒序（同日期按原牌谱顺序稳定排列）
  for (const list of out.values()) {
    list.sort((a, b) => {
      const byDate = String(b.date).localeCompare(String(a.date));
      return byDate !== 0 ? byDate : a.ord - b.ord;
    });
  }
  return out;
}
