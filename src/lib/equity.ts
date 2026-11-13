/**
 * Heads-up All-in Equity 精确计算模块
 * ====================================
 * 翻后 (flop/turn/river)：精确枚举所有剩余 board 组合，用现有 evaluate()。
 * 翻前 (preflop)：查 169×169 预计算表（见 preflop-table.ts），离线生成一次。
 *
 * 生成表：node scripts/gen-preflop-table.js
 */

import { evaluate, compareRanks } from "./poker";
import { PREFLOP_TABLE } from "./preflop-table";

// ── Hand class encoding: 0..168 ──────────────────────────────
//
// Pairs (0-12):      AA→0, KK→1, QQ→2, ... 22→12
// Suited  (13-90):   AKs→13, AQs→14, ... 32s→90  (78 combos, hi-to-lo)
// Offsuit (91-168):  AKo→91, AQo→92, ... 32o→168 (78 combos)
//
// RANK_CHARS = "23456789TJQKA" → A=12, K=11, ..., 2=0

export function classifyHand(card1: number, card2: number): number {
  const r1 = card1 % 13;
  const r2 = card2 % 13;
  const s1 = Math.floor(card1 / 13);
  const s2 = Math.floor(card2 / 13);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);

  if (r1 === r2) {
    // Pair: AA → 0 (hi=12), 22 → 12 (hi=0)
    return 12 - hi;
  }

  // Non-pair: position within suited/offsuit blocks
  // Number of non-pair combos with higher high card:
  //   sum_{k=hi+1}^{12} k = 12*13/2 - hi*(hi+1)/2
  const totalHigher = 78 - (hi * (hi + 1)) / 2;
  const posWithinHi = hi - lo - 1;
  const pos = totalHigher + posWithinHi;

  if (s1 === s2) {
    return 13 + pos;        // Suited: 13..90
  } else {
    return 13 + 78 + pos;   // Offsuit: 91..168
  }
}

/** 查预计算表获取翻前 equity */
export function preflopEquity(heroCards: number[], villainCards: number[]): number {
  const hc = classifyHand(heroCards[0], heroCards[1]);
  const vc = classifyHand(villainCards[0], villainCards[1]);
  return PREFLOP_TABLE[hc * 169 + vc];
}

// ── 翻后精确枚举 ─────────────────────────────────────────────

/**
 * 精确枚举所有剩余 board 组合，计算 Hero vs Villain 的 heads-up equity。
 *
 * boardCards: 全押时已发的公共牌（3=flop, 4=turn, 5=river）
 * 返回 { win, tie, lose } 占比
 */
export function exactPostflopEquity(
  heroHole: number[],
  villainHole: number[],
  boardCards: number[],
): { win: number; tie: number; lose: number } {
  if (boardCards.length === 5) {
    // River: result is deterministic
    const cmp = compareRanks(
      evaluate([...heroHole, ...boardCards]),
      evaluate([...villainHole, ...boardCards]),
    );
    return { win: cmp > 0 ? 1 : 0, tie: cmp === 0 ? 1 : 0, lose: cmp < 0 ? 1 : 0 };
  }

  const used = new Set([...heroHole, ...villainHole, ...boardCards]);
  const deck: number[] = [];
  for (let i = 0; i < 52; i++) {
    if (!used.has(i)) deck.push(i);
  }

  const need = 5 - boardCards.length;
  if (need <= 0 || need > deck.length) {
    return { win: 0, tie: 0, lose: 0 };
  }

  let win = 0;
  let tie = 0;
  let total = 0;
  const combo = new Array(need);
  const heroArr = [...heroHole];
  const villainArr = [...villainHole];
  const boardArr = [...boardCards];

  function dfs(start: number, depth: number): void {
    if (depth === need) {
      const fullBoard = boardArr.concat(combo);
      const cmp = compareRanks(
        evaluate(heroArr.concat(fullBoard)),
        evaluate(villainArr.concat(fullBoard)),
      );
      if (cmp > 0) win++;
      else if (cmp === 0) tie++;
      total++;
      return;
    }
    for (let i = start; i < deck.length; i++) {
      combo[depth] = deck[i];
      dfs(i + 1, depth + 1);
    }
  }

  dfs(0, 0);

  if (total === 0) return { win: 0, tie: 0, lose: 0 };
  return {
    win: win / total,
    tie: tie / total,
    lose: (total - win - tie) / total,
  };
}

/**
 * 统一入口：根据 board 状态选择合适的 equity 计算方式。
 * 返回 Hero 的 equity（含平局一半）。
 */
export function computeAllInEquity(
  heroHole: number[],
  villainHole: number[],
  boardAtAllIn: number[],
): number {
  if (boardAtAllIn.length >= 3) {
    // 翻后精确枚举
    const r = exactPostflopEquity(heroHole, villainHole, boardAtAllIn);
    return r.win + r.tie / 2;
  }
  // 翻前查表
  return preflopEquity(heroHole, villainHole);
}

// ── N 路 All-in Equity（精确枚举 + 翻前缓存）────────────────
//
// 多路全下（分层边池）需要 N 路 equity；翻前精确枚举 C(46..48,5) 约 1.4~1.7M
// 副牌，单次 ~2s，必须按「花色同构归一化」的底牌集合做缓存——同一局面结构
// （同 rank 骨架 + 同花色重叠模式）只在首次出现时付一次枚举成本。
//
// 快速评估器与 poker.ts 的 evaluate 语义一致（7 张取最优 5 张），但零分配、
// 单态化，供枚举内层使用；等价性由 .tmp-check 验收脚本随机对拍保证。

const ecRankCount = new Int32Array(15);
const ecSuitMask = new Int32Array(4);
// 单挑翻前热路径的 7 张槽位（JS 单线程、枚举内无重入，模块级复用免分配）
const hands0 = [0, 0, 0, 0, 0, 0, 0];
const hands1 = [0, 0, 0, 0, 0, 0, 0];

// cat-major、base-15 打包的牌力分数（仅用于快速评估器内部比较）
function ecScore(cat: number, k0: number, k1: number, k2: number, k3: number, k4: number): number {
  return ((((cat * 15 + k0) * 15 + k1) * 15 + k2) * 15 + k3) * 15 + k4;
}
function ecStraight(mask: number): number {
  const m = mask | ((mask & (1 << 14)) ? (1 << 1) : 0); // A-low
  for (let hi = 14; hi >= 5; hi--) {
    const w = 31 << (hi - 4);
    if ((m & w) === w) return hi;
  }
  return 0;
}
function ecKickers(bits: number, exclude: number, n: number, out: number[]): void {
  let cnt = 0;
  for (let r = 14; r >= 2 && cnt < n; r--) {
    if (bits & (1 << r) && !(exclude & (1 << r))) out[cnt++] = r;
  }
  while (cnt < n) out[cnt++] = 0;
}
const ecK = [0, 0, 0, 0, 0];
/** 7 张牌（suit*13+rank 编码）的最优 5 张分数。与 evaluate/compareRanks 严格同序。 */
export function eval7Fast(cs: ArrayLike<number>): number {
  ecRankCount.fill(0);
  ecSuitMask[0] = ecSuitMask[1] = ecSuitMask[2] = ecSuitMask[3] = 0;
  let rankBits = 0;
  for (let i = 0; i < 7; i++) {
    const c = cs[i];
    const r = (c % 13) + 2;
    const s = (c / 13) | 0;
    ecRankCount[r]++;
    ecSuitMask[s] |= 1 << r;
    rankBits |= 1 << r;
  }
  let fs = -1;
  for (let s = 0; s < 4; s++) {
    let m = ecSuitMask[s];
    let pc = 0;
    while (m) { m &= m - 1; pc++; }
    if (pc >= 5) { fs = s; break; }
  }
  if (fs >= 0) {
    const m = ecSuitMask[fs];
    const sf = ecStraight(m);
    if (sf) return ecScore(8, sf, 0, 0, 0, 0);
    ecKickers(m, 0, 5, ecK);
    return ecScore(5, ecK[0], ecK[1], ecK[2], ecK[3], ecK[4]);
  }
  let quad = 0;
  let tripsHi = 0;
  let tripsLo = 0;
  let pairHi = 0;
  let pairLo = 0;
  for (let r = 14; r >= 2; r--) {
    const cnt = ecRankCount[r];
    if (cnt === 4) quad = r;
    else if (cnt === 3) { if (!tripsHi) tripsHi = r; else if (!tripsLo) tripsLo = r; }
    else if (cnt === 2) { if (!pairHi) pairHi = r; else if (!pairLo) pairLo = r; }
  }
  if (quad) {
    ecKickers(rankBits, 1 << quad, 1, ecK);
    return ecScore(7, quad, ecK[0], 0, 0, 0);
  }
  if (tripsHi && (tripsLo || pairHi)) {
    return ecScore(6, tripsHi, tripsLo || pairHi, 0, 0, 0); // 葫芦
  }
  const st = ecStraight(rankBits);
  if (st) return ecScore(4, st, 0, 0, 0, 0); // 顺子：落后于葫芦、领先于三条
  if (tripsHi) {
    ecKickers(rankBits, 1 << tripsHi, 2, ecK);
    return ecScore(3, tripsHi, ecK[0], ecK[1], 0, 0);
  }
  if (pairHi && pairLo) {
    ecKickers(rankBits, (1 << pairHi) | (1 << pairLo), 1, ecK);
    return ecScore(2, pairHi, pairLo, ecK[0], 0, 0);
  }
  if (pairHi) {
    ecKickers(rankBits, 1 << pairHi, 3, ecK);
    return ecScore(1, pairHi, ecK[0], ecK[1], ecK[2], 0);
  }
  ecKickers(rankBits, 0, 5, ecK);
  return ecScore(0, ecK[0], ecK[1], ecK[2], ecK[3], ecK[4]);
}

/**
 * N 路 all-in equity（含平局均分）：枚举所有剩余公共牌，
 * 返回 Hero 的期望底池份额 ∈ [0,1]。牌面已完整时直接判定（确定性）。
 */
export function exactNwayEquity(heroHole: number[], oppHoles: number[][], boardCards: number[]): number {
  const nPlayers = oppHoles.length + 1;
  const used = new Set<number>(heroHole);
  for (const o of oppHoles) for (const c of o) used.add(c);
  for (const c of boardCards) used.add(c);
  const deck: number[] = [];
  for (let i = 0; i < 52; i++) if (!used.has(i)) deck.push(i);

  const need = 5 - boardCards.length;
  if (need < 0 || need > deck.length) return 0;

  // 单挑翻前热路径（占绝对多数）：五层平铺循环，leaf 直接把公共牌写进 7 张槽位。
  // 语义与下面的通用递归完全一致；实测单次 C(48,5) 全枚举 ~250ms → ~100ms。
  if (nPlayers === 2 && need === 5) {
    const h0 = hands0;
    h0[0] = heroHole[0];
    h0[1] = heroHole[1];
    const o0 = hands1;
    o0[0] = oppHoles[0][0];
    o0[1] = oppHoles[0][1];
    const n = deck.length;
    let total = 0;
    let heroShare = 0;
    for (let a = 0; a <= n - 5; a++) {
      const c0 = deck[a];
      for (let b = a + 1; b <= n - 4; b++) {
        const c1 = deck[b];
        for (let c = b + 1; c <= n - 3; c++) {
          const c2 = deck[c];
          for (let d = c + 1; d <= n - 2; d++) {
            const c3 = deck[d];
            for (let e = d + 1; e <= n - 1; e++) {
              const c4 = deck[e];
              h0[2] = c0; h0[3] = c1; h0[4] = c2; h0[5] = c3; h0[6] = c4;
              o0[2] = c0; o0[3] = c1; o0[4] = c2; o0[5] = c3; o0[6] = c4;
              const sh = eval7Fast(h0);
              const so = eval7Fast(o0);
              if (sh > so) heroShare += 1;
              else if (sh === so) heroShare += 0.5;
              total++;
            }
          }
        }
      }
    }
    return total > 0 ? heroShare / total : 0;
  }

  // 每个玩家的 7 张槽位：前 2 张底牌固定，后 5 张随枚举填充
  const hands: number[][] = new Array(nPlayers);
  hands[0] = [heroHole[0], heroHole[1], 0, 0, 0, 0, 0];
  for (let p = 1; p < nPlayers; p++) hands[p] = [oppHoles[p - 1][0], oppHoles[p - 1][1], 0, 0, 0, 0, 0];
  const board = boardCards.slice();
  const scores = new Array(nPlayers).fill(0);

  let total = 0;
  let heroShare = 0;
  (function dfs(start: number, depth: number): void {
    if (depth === need) {
      for (let i = 0; i < 5; i++) {
        const c = i < board.length ? board[i] : 0;
        for (let p = 0; p < nPlayers; p++) hands[p][i + 2] = c;
      }
      let best = -1;
      let bestCnt = 0;
      let heroBest = 0;
      for (let p = 0; p < nPlayers; p++) {
        const s = eval7Fast(hands[p]);
        scores[p] = s;
        if (s > best) { best = s; bestCnt = 1; }
        else if (s === best) bestCnt++;
        if (p === 0) heroBest = s;
      }
      if (heroBest === best && best > 0) heroShare += 1 / bestCnt;
      total++;
      return;
    }
    for (let i = start; i <= deck.length - need + depth; i++) {
      board.push(deck[i]);
      dfs(i + 1, depth + 1);
      board.pop();
    }
  })(0, 0);

  return total > 0 ? heroShare / total : 0;
}

// ── 翻前精确枚举缓存（花色同构归一化）──────────────────────
const preflopExactCache = new Map<string, number>();
const cacheStats = { hits: 0, misses: 0, nsTotal: 0 };

/** 花色同构归一化 key：同结构局面（rank 骨架 + 花色重叠模式）必得同一 key。 */
function canonicalMatchupKey(heroHole: number[], oppHoles: number[][]): string {
  const suitMap = new Map<number, number>();
  let nextSuit = 0;
  const norm = (c: number): number => {
    const r = c % 13;
    const s = (c / 13) | 0;
    let m = suitMap.get(s);
    if (m === undefined) {
      m = nextSuit++;
      suitMap.set(s, m);
    }
    return m * 13 + r;
  };
  const parts: string[] = [];
  // 先按原始顺序归一化（首现归一化对花色置换是规范形），再于每手内排序稳定化
  for (const hand of [heroHole, ...oppHoles]) {
    const a = hand.map(norm).sort((x, y) => x - y);
    parts.push(a.join("."));
  }
  return `${oppHoles.length}|${parts.join("|")}`;
}

/**
 * N 路统一入口：翻前走精确枚举 + 缓存；翻后直接精确枚举（≤903 副，成本可忽略）。
 * 返回 Hero 的期望底池份额 ∈ [0,1]（含平局均分）。
 */
export function computeAllInEquityNway(
  heroHole: number[],
  oppHoles: number[][],
  boardAtAllIn: number[],
): number {
  if (oppHoles.length === 0) return 1;
  if (boardAtAllIn.length >= 5) {
    // 河牌：确定性
    const share = exactNwayEquity(heroHole, oppHoles, boardAtAllIn);
    return share;
  }
  if (boardAtAllIn.length > 0) {
    return exactNwayEquity(heroHole, oppHoles, boardAtAllIn);
  }
  // 翻前：归一化缓存
  const key = canonicalMatchupKey(heroHole, oppHoles);
  const hit = preflopExactCache.get(key);
  if (hit !== undefined) {
    cacheStats.hits++;
    return hit;
  }
  cacheStats.misses++;
  const t0 = Date.now();
  const eq = exactNwayEquity(heroHole, oppHoles, []);
  cacheStats.nsTotal += Date.now() - t0;
  preflopExactCache.set(key, eq);
  return eq;
}

/** 缓存统计（验收/性能汇报用）。 */
export function preflopEquityCacheInfo(): { size: number; hits: number; misses: number; nsTotal: number } {
  return { size: preflopExactCache.size, hits: cacheStats.hits, misses: cacheStats.misses, nsTotal: cacheStats.nsTotal };
}
