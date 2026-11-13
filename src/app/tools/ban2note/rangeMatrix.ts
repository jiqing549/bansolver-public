/* ================================================================
   ban2note · 对比GTO —— 范围矩阵计算
   ----------------------------------------------------------------
   把「手牌历史的 PFR 分布」和「GTO 范围串」统一成 13×13 频率矩阵，
   逐格算 delta，供前端直接渲染。

   网格约定（与站内 range 工具一致）：
     • RANKS = "AKQJT98765432"，下标 0..12 对应 A..2
     • 对角线 = 对子；右上三角(r<c) = suited；左下三角(r>c) = offsuit
     • grid[r][c] ∈ [0,1]，表示该组合的开牌频率
   ================================================================ */

import type { ParsedHand } from "@/lib/hhTypes";

export const RANKS = "AKQJT98765432";
const RANK_CHARS_LOW = "23456789TJQKA"; // parseCard 的 rank 字符（与 poker.ts 一致）
export const GRID_N = 13;

export type FreqGrid = number[][]; // 13×13，值 0..1

/** GTO 文件里 6-max 槽位的显示顺序 */
export const GTO_POSITION_ORDER = ["UTG", "MP", "CO", "BTN", "SB", "BB"] as const;
export type GtoSlot = (typeof GTO_POSITION_ORDER)[number];

/**
 * GGPoker heroPosition → 6-max GTO 槽位。
 * 6-max 桌 GGPoker 中间位是 UTG/MP/CO，直接对位；
 * 7-9 人桌多出来的 UTG+1/UTG+2 归到 UTG 槽、HJ（晚中位）归到 MP 槽。
 * 如果你 GTO 文件的位置命名不同，只改这张表即可。
 */
const SLOT_ALIAS_RAW: Record<string, GtoSlot> = {
  UTG: "UTG",
  "UTG+1": "UTG",
  "UTG+2": "UTG",
  MP: "MP",
  HJ: "MP",
  CO: "CO",
  BTN: "BTN",
  SB: "SB",
  BB: "BB",
};

export function heroPositionToSlot(pos: string): GtoSlot | null {
  return SLOT_ALIAS_RAW[pos] ?? null;
}

/** 空矩阵（全 0） */
export function emptyGrid(): FreqGrid {
  return Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0));
}

/** 复制矩阵 */
export function cloneGrid(g: FreqGrid): FreqGrid {
  return g.map((row) => [...row]);
}

/**
 * 把单个组合标签（如 "AKs"/"T9o"/"QQ"）累加进 grid 指定频率。
 * 不带 s/o 后缀且两字符相同 → 对子；两字符不同默认按「两种都涂」处理
 * （GTO 范围串里裸 "AK" 一般表示 AKs+AKo 一起开）。
 */
function addCombo(grid: FreqGrid, label: string, freq: number) {
  if (label.length < 2) return;
  const r0 = label[0].toUpperCase();
  const r1 = label[1].toUpperCase();
  const ri = RANKS.indexOf(r0);
  const ci = RANKS.indexOf(r1);
  if (ri < 0 || ci < 0) return;

  const isPair = r0 === r1;
  const suffix = label[2]?.toLowerCase();

  if (isPair) {
    grid[ri][ri] = Math.min(1, grid[ri][ri] + freq);
  } else if (suffix === "s") {
    // suited：大点数在 r，小点数在 c（右上三角 r<c）
    const r = Math.min(ri, ci);
    const c = Math.max(ri, ci);
    grid[r][c] = Math.min(1, grid[r][c] + freq);
  } else if (suffix === "o") {
    // offsuit：小点数在 r，大点数在 c（左下三角 r>c）
    const r = Math.max(ri, ci);
    const c = Math.min(ri, ci);
    grid[r][c] = Math.min(1, grid[r][c] + freq);
  } else {
    // 无后缀的非对子：两种花色组合都涂（AK = AKs + AKo）
    const rHi = Math.min(ri, ci);
    const cHi = Math.max(ri, ci);
    grid[rHi][cHi] = Math.min(1, grid[rHi][cHi] + freq); // suited
    const rLo = Math.max(ri, ci);
    const cLo = Math.min(ri, ci);
    grid[rLo][cLo] = Math.min(1, grid[rLo][cLo] + freq); // offsuit
  }
}

/**
 * 解析范围串，如 "AA, AKs, KTo:0.77, 55:0.86, 65s:0.4"。
 * 支持：
 *   • 对子 / Xs / Xo / 裸两字符（=s+o）
 *   • :freq 混合频率后缀（0..1）
 *   • "XX+" 连张递增（如 "ATs+"、"55+"、"T9s+"）
 */
export function parseFreqRange(str: string): FreqGrid {
  const grid = emptyGrid();
  if (!str) return grid;

  const tokens = str.split(/[,\s]+/).filter(Boolean);
  for (let raw of tokens) {
    raw = raw.trim();
    if (!raw) continue;

    let freq = 1;
    const colonIdx = raw.lastIndexOf(":");
    if (colonIdx > 0) {
      const f = parseFloat(raw.slice(colonIdx + 1));
      if (!Number.isNaN(f)) freq = Math.max(0, Math.min(1, f));
      raw = raw.slice(0, colonIdx);
    }

    const plus = raw.endsWith("+");
    const base = plus ? raw.slice(0, -1) : raw;

    if (plus) {
      // 展开 "+": 把 kicker（或对子）递增到最大
      expandPlus(grid, base, freq);
    } else {
      addCombo(grid, base, freq);
    }
  }
  return grid;
}

/** 展开 "XX+" 形式：对子递增到 AA；连张 kicker 递增到大点数 */
function expandPlus(grid: FreqGrid, base: string, freq: number) {
  const r0 = base[0]?.toUpperCase();
  const r1 = base[1]?.toUpperCase();
  const suffix = base[2]?.toLowerCase();
  const ri = RANKS.indexOf(r0);
  const ci = RANKS.indexOf(r1);
  if (ri < 0 || ci < 0) return;

  if (r0 === r1) {
    // 对子：从该对子到 AA
    for (let r = ri; r >= 0; r--) addCombo(grid, RANKS[r] + RANKS[r], freq);
  } else {
    // 连张：kicker 从当前递增到大点数
    const hi = Math.min(ri, ci); // 大点数下标（更靠 A）
    const loStart = Math.max(ri, ci); // 小点数起始下标
    const tag = suffix === "o" ? "o" : suffix === "s" ? "s" : "";
    for (let lo = loStart; lo >= hi + 1; lo--) {
      const lbl = RANKS[hi] + RANKS[lo] + tag;
      addCombo(grid, lbl, freq);
    }
  }
}

/**
 * 把两张具体牌（"Ah Kd" 的 card code）归一化成 grid 坐标 [row, col]。
 * card code = suit*13 + rank，rank 0..12 对应 2..A（见 poker.ts）。
 * 返回 null 表示无法归类（牌不合法等）。
 */
export function holeCardsToCell(card1: number, card2: number): [number, number] | null {
  if (card1 < 0 || card2 < 0) return null;
  // rank: 0..12 对应 2..A；转换到 RANKS 下标（A=0, 2=12）
  const rankToIdx = (card: number) => {
    const rank = card % 13; // 0=2 ... 12=A
    return 12 - rank; // A→0, 2→12
  };
  const a = rankToIdx(card1);
  const b = rankToIdx(card2);
  const suit1 = Math.floor(card1 / 13);
  const suit2 = Math.floor(card2 / 13);

  if (a === b) return [a, a]; // 对子
  if (suit1 === suit2) {
    // suited：右上三角，大点数（A 侧，下标小）在 row
    return [Math.min(a, b), Math.max(a, b)];
  }
  // offsuit：左下三角，小点数（2 侧，下标大）在 row
  return [Math.max(a, b), Math.min(a, b)];
}

/** 从 "Ah Kd" 这样的字符串解析两张牌的 card code */
export function parseHoleString(s: string): [number, number] | null {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const c1 = cardCode(parts[0]);
  const c2 = cardCode(parts[1]);
  if (c1 < 0 || c2 < 0) return null;
  return [c1, c2];
}

function cardCode(s: string): number {
  if (!s || s.length < 2) return -1;
  const rankChar = s[0].toUpperCase();
  const suitChar = s[1].toLowerCase();
  const rank = RANK_CHARS_LOW.indexOf(rankChar); // 0..12 对应 2..A
  const suit = "shdc".indexOf(suitChar);
  if (rank < 0 || suit < 0) return -1;
  return suit * 13 + rank;
}

/** grid[r][c] 的显示标签（如 "AKs"） */
export function cellLabel(r: number, c: number): string {
  if (r === c) return RANKS[r] + RANKS[r];
  if (r < c) return RANKS[r] + RANKS[c] + "s";
  return RANKS[c] + RANKS[r] + "o";
}

/**
 * 用户 RFI（Raise First In）范围矩阵。
 * 语义：对每个组合格子，频率 = (该组合 isRFI 的次数) / (该组合有 RFI 机会的次数)。
 *   • 分子 isRFI = hero 翻前首次加注且之前无人自愿入池
 *   • 分母 rfiOpportunity = hero 行动前无人自愿入池（即 hero 有 RFI 决策权）
 * 这样排除「前面有人加注/limp、hero 没有 RFI 机会」的手牌，与 GTO 的 RFI 范围严格可比。
 *
 * @returns { grid, sample }  sample[r][c] = 该组合有 RFI 机会的次数（用于 UI 标注样本可信度）
 */
export function buildUserPFRGrid(
  hands: ParsedHand[],
): { grid: FreqGrid; sample: number[][] } {
  const opp = Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0)); // RFI 机会次数（分母）
  const raised = Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0));

  for (const h of hands) {
    if (!h.heroCards) continue;
    const cards = parseHoleString(h.heroCards);
    if (!cards) continue;
    const cell = holeCardsToCell(cards[0], cards[1]);
    if (!cell) continue;
    const [r, c] = cell;
    if (!h.rfiOpportunity) continue; // 没有 RFI 机会的不计入分母
    opp[r][c] += 1;
    if (h.isRFI) raised[r][c] += 1;
  }

  const grid = emptyGrid();
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      grid[r][c] = opp[r][c] > 0 ? raised[r][c] / opp[r][c] : 0;
    }
  }
  return { grid, sample: opp };
}

/** 频率阈值：低于此值的用户格子视为 0%（当作没开），用于 delta 计算。 */
export const USER_FREQ_THRESHOLD = 0.03;

/** 返回 grid 的副本，频率 < threshold 的格子归零（不影响原 grid）。 */
export function applyThreshold(g: FreqGrid, threshold: number): FreqGrid {
  return g.map((row) => row.map((v) => (v < threshold ? 0 : v)));
}

/** delta = user − gto，逐格。值域 [-1, 1]。
 *  负数 = 用户比 GTO 少开（漏开/偏紧）；正数 = 用户比 GTO 多开（过度/偏松）。
 */
export function buildDeltaGrid(gto: FreqGrid, user: FreqGrid): FreqGrid {
  const d = emptyGrid();
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      d[r][c] = user[r][c] - gto[r][c];
    }
  }
  return d;
}

/** 矩阵里非零格子的数量（用于判断 GTO 槽位是否为空） */
export function nonZeroCount(g: FreqGrid): number {
  let n = 0;
  for (const row of g) for (const v of row) if (v > 0.001) n += 1;
  return n;
}

/**
 * 矩阵的「整体开牌频率」——每个格子的频率按该组合的理论组合数加权后求和，
 * 再除以 1326（全部起手牌组合数），得到「理论上有多大概率被开」。
 * 这样用户 PFR% 和 GTO% 直接可比，差值一目了然。
 *
 * 组合数：对子=6，suited=4，offsuit=12（共 13×6 + 78×4 + 78×12 = 1326）。
 */
const COMBO_WEIGHTS = (() => {
  const w: number[][] = Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0));
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      if (r === c) w[r][c] = 6; // 对子
      else if (r < c) w[r][c] = 4; // suited（右上三角）
      else w[r][c] = 12; // offsuit（左下三角）
    }
  }
  return w;
})();
const TOTAL_COMBOS = 1326;

export function overallFreq(g: FreqGrid): number {
  let sum = 0;
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      sum += g[r][c] * COMBO_WEIGHTS[r][c];
    }
  }
  return sum / TOTAL_COMBOS;
}

/* ================================================================
   BB 防守范围矩阵（BB vs open raise）
   ----------------------------------------------------------------
   场景：hero 在 BB，某对手位置（UTG/MP/CO/BTN/SB）开池（无人 limp、
   非 squeeze、非 4bet 池）后 hero 的防守决策。

   纯净防守判定（调用方已按 openRaiserPos 分组，传入该位置的手牌）：
     heroPosition === "BB"
     && facingRaise              // 翻前恰好 1 次 raise（排除 4bet 池）
     && !squeezeOpp && !isSqueeze // 排除 open raise + caller
     && limpersBeforeFirstRaise === 0  // 排除 limp + iso-raise

   返回三个矩阵：
     grid3bet[r][c] = hero 3bet 频率（threeBet / 机会数）
     gridCall[r][c] = hero call 频率（facedOpenRaiseAndCalled / 机会数）
     sample[r][c]   = 该组合有防守机会的次数（UI 样本标注）
   ================================================================ */

/** BB 面对开池的 5 个防守对手位置（GTO 槽位顺序） */
export const BB_DEFEND_OPPS = ["UTG", "MP", "CO", "BTN", "SB"] as const;
export type BBDefendOpp = (typeof BB_DEFEND_OPPS)[number];

/** GTO 数据里 BB 防守范围的 key 前缀（如 BB_vs_BTN_3bet） */
export function bbDefendGtoKey(opp: string, kind: "3bet" | "call"): string {
  return `BB_vs_${opp}_${kind}`;
}

export function buildBBDefendGrid(
  hands: ParsedHand[],
): { grid3bet: FreqGrid; gridCall: FreqGrid; sample: number[][] } {
  const opp = Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0));
  const threebet = Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0));
  const call = Array.from({ length: GRID_N }, () => Array(GRID_N).fill(0));

  for (const h of hands) {
    if (!h.heroCards) continue;
    const cards = parseHoleString(h.heroCards);
    if (!cards) continue;
    const cell = holeCardsToCell(cards[0], cards[1]);
    if (!cell) continue;
    const [r, c] = cell;
    opp[r][c] += 1;
    if (h.threeBet) threebet[r][c] += 1;
    else if (h.facedOpenRaiseAndCalled) call[r][c] += 1;
  }

  const grid3bet = emptyGrid();
  const gridCall = emptyGrid();
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      grid3bet[r][c] = opp[r][c] > 0 ? threebet[r][c] / opp[r][c] : 0;
      gridCall[r][c] = opp[r][c] > 0 ? call[r][c] / opp[r][c] : 0;
    }
  }
  return { grid3bet, gridCall, sample: opp };
}

