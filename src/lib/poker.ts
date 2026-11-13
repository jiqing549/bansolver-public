/* ================================================================
   Poker hand evaluator — shared across tools
   Seven-card Texas Hold'em best-5 hand ranking
   ================================================================

   牌力评估算法：
     • evaluate5()  对恰好 5 张牌直接判定类别（顺子/同花/对子计数）
     • evaluate()   对 5~7 张牌枚举所有 C(n,5) 组合，取最强。7 张=C(7,5)=21
                   组合，开销可接受；不做预计算表，保持代码简单。
     • compareRanks()  字典序比较 [category, ...kickers]，category 越大越强

   牌编码：card = suit*13 + rank，rank 0..12 对应 2..A，suit 0..3 对应 s/h/d/c。
   ================================================================ */

// Card: 0-51. Rank = val % 13 (2=0 ... A=12), Suit = val / 13 (s=0,h=1,d=2,c=3)
const RANK_CHARS = "23456789TJQKA";
const SUIT_CHARS = "shdc";

export function cardToString(c: number): string {
  const rank = RANK_CHARS[c % 13];
  const suit = SUIT_CHARS[Math.floor(c / 13)];
  return rank + suit;
}

export function parseCard(s: string): number {
  const rank = RANK_CHARS.indexOf(s[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(s[1].toLowerCase());
  if (rank === -1 || suit === -1) return -1;
  return suit * 13 + rank;
}

// Best 5-card hand rank: higher = stronger
// Returns [category, ...kickers] where category: 8=straightFlush, 7=quads, 6=boat, 5=flush, 4=straight, 3=trips, 2=twoPair, 1=pair, 0=high
export function evaluate5(hand: number[]): number[] {
  const ranks = hand.map((c) => c % 13).sort((a, b) => b - a);
  const suits = hand.map((c) => Math.floor(c / 13));
  const flush = new Set(suits).size === 1;

  // Straight check
  let straight = false;
  let straightHigh = -1;
  if (new Set(ranks).size === 5) {
    if (ranks[0] - ranks[4] === 4) {
      straight = true;
      straightHigh = ranks[0];
    } else if (ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 && ranks[3] === 1 && ranks[4] === 0) {
      straight = true;
      straightHigh = 3; // Wheel
    }
  }

  if (flush && straight) return [8, straightHigh];
  if (flush) return [5, ...ranks];

  if (straight) return [4, straightHigh];

  // Count pairs
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (entries[0][1] === 4) return [7, entries[0][0], entries[1][0]];
  if (entries[0][1] === 3 && entries[1][1] === 2) return [6, entries[0][0], entries[1][0]];
  if (entries[0][1] === 3) return [3, entries[0][0], entries[1][0], entries[2][0]];
  if (entries[0][1] === 2 && entries[1][1] === 2) return [2, entries[0][0], entries[1][0], entries[2][0]];
  if (entries[0][1] === 2) return [1, entries[0][0], entries[1][0], entries[2][0], entries[3][0]];
  return [0, ...ranks];
}

export function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

// Evaluate best 5-card hand from 5-7 cards
export function evaluate(cards: number[]): number[] {
  let best: number[] = [];
  // Generate all C(n,5)
  const n = cards.length;
  const combos = combinations(n, 5);
  for (const c of combos) {
    const hand = c.map((i) => cards[i]);
    const rank = evaluate5(hand);
    if (best.length === 0 || compareRanks(rank, best) > 0) best = rank;
  }
  return best;
}

function combinations(n: number, k: number): number[][] {
  const result: number[][] = [];
  const combo: number[] = [];
  function backtrack(start: number) {
    if (combo.length === k) { result.push([...combo]); return; }
    for (let i = start; i < n; i++) { combo.push(i); backtrack(i + 1); combo.pop(); }
  }
  backtrack(0);
  return result;
}

// Monte Carlo equity: hero has hole cards, board may have some cards
// villainRange: array of [c1, c2] pairs, or null for random
// 收敛：runs=15000 时胜率标准误约 0.4%（p=0.5, σ=√(p(1-p)/n)≈0.004），
// 足够 badbeat/odds 工具的显示精度。更精确请用 runs≥100000。
type Range = number[][];

export function monteCarloEquity(
  heroHole: number[],
  boardCards: number[],
  villainRange: Range | null,
  runs: number
): { win: number; tie: number; lose: number } {
  const used = new Set([...heroHole, ...boardCards]);
  const remainingBoard = 5 - boardCards.length;
  let win = 0, tie = 0, lose = 0;

  // Filter range to available pairs
  let availablePairs: Range | null = null;
  if (villainRange) {
    availablePairs = villainRange.filter(
      ([c1, c2]) => !used.has(c1) && !used.has(c2)
    );
    if (availablePairs.length === 0) availablePairs = null;
  }

  // 每轮先抽定 villain 底牌，再从「hero+公共牌+villain 都剔除」的牌堆补公共牌。
  // 旧实现 deck 只剔 hero+公共牌：指定 villain 底牌（badbeat 页固定传一对）时
  // 这两张牌留在堆里，约 8% 的模拟会把同一张物理牌再发到公共牌上——villain
  // 等于多拿一张牌，系统性抬高其成牌分布（2026-11-03 审查 P1）
  const deckTemplate: number[] = [];
  for (let i = 0; i < 52; i++) {
    if (!used.has(i)) deckTemplate.push(i);
  }

  for (let r = 0; r < runs; r++) {
    let villainHole: number[];
    let deck: number[];
    if (availablePairs) {
      const pi = Math.floor(Math.random() * availablePairs.length);
      villainHole = availablePairs[pi];
      const vUsed = new Set([...used, ...villainHole]);
      deck = deckTemplate.filter((c) => !vUsed.has(c));
    } else {
      villainHole = [];
      deck = deckTemplate;
    }

    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const fullBoard = [...boardCards, ...shuffled.slice(0, remainingBoard)];

    if (!availablePairs) {
      villainHole = [shuffled[remainingBoard], shuffled[remainingBoard + 1]];
    }

    const heroRank = evaluate([...heroHole, ...fullBoard]);
    const villainRank = evaluate([...villainHole, ...fullBoard]);
    const cmp = compareRanks(heroRank, villainRank);
    if (cmp > 0) win++;
    else if (cmp === 0) tie++;
    else lose++;
  }
  return { win: win / runs, tie: tie / runs, lose: lose / runs };
}

// Parse range string → array of [c1, c2] pairs
export function parseRange(s: string): Range {
  const pairs: Range = [];
  const parts = s.split(/[,;\s]+/).filter(Boolean);
  for (const p of parts) {
    if (p.length === 4 && (p[2] === "s" || p[2] === "o")) {
      const r1 = RANK_CHARS.indexOf(p[0].toUpperCase());
      const r2 = RANK_CHARS.indexOf(p[1].toUpperCase());
      if (r1 === -1 || r2 === -1) continue;
      const suited = p[2] === "s";
      for (let s1 = 0; s1 < 4; s1++) {
        for (let s2 = 0; s2 < 4; s2++) {
          // 编码 card = suit*13 + rank：同花色(s1===s2)即同花组合；
          // 旧条件(s1===s2 一律跳过 + suited 再要求 s1!==s2)互斥，任何 "AKs"
          // 都解析出 0 组合（当前仓库无消费者，属潜伏 bug，2026-11-03 修正）
          if (suited) {
            if (s1 !== s2) continue;
          } else if (s1 === s2) {
            continue;
          }
          pairs.push([s1 * 13 + r1, s2 * 13 + r2]);
        }
      }
    } else if (p.length === 2) {
      const r1 = RANK_CHARS.indexOf(p[0].toUpperCase());
      const r2 = RANK_CHARS.indexOf(p[1].toUpperCase());
      if (r1 !== r2 || r1 === -1) continue;
      for (let s1 = 0; s1 < 4; s1++) {
        for (let s2 = s1 + 1; s2 < 4; s2++) {
          pairs.push([s1 * 13 + r1, s2 * 13 + r2]);
        }
      }
    } else if (p.length === 4) {
      const c1 = parseCard(p.slice(0, 2));
      const c2 = parseCard(p.slice(2, 4));
      if (c1 >= 0 && c2 >= 0) pairs.push([c1, c2]);
    }
  }
  return pairs;
}

export const HAND_NAMES = [
  "高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"
];
