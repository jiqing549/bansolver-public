/* ================================================================
   Stove Equity — PokerStove (ps-eval) 语义的德州扑克 Equity 引擎
   ================================================================

   算法语义移植自开源 pokerstove (andrewprock/pokerstove, BSD-3)：
     • CardDistribution::parse  → 具体牌组合语法（连写、逗号分隔、=权重）
     • evaluateShowdown         → N 路 showdown 计票：唯一赢家 win+=w；
                                  k 人平分各 tie+=w/k（无 lose 计数器，
                                  lose = 1 - equity）
     • ShowdownEnumerator +     → 精确模式：对剩余 board 做字典序组合穷举
       util/combinations::next     （可分块推进，翻前 C(48,5)=1,712,304）
     • ps-eval main             → 玩家留空 = 随机（全部 1326 组合）；
                                  含范围/随机玩家时自动降级 Monte Carlo

   牌编码沿用 poker.ts：card = suit*13 + rank，
   suit s=0/h=1/d=2/c=3，rank 2=0 … A=12。

   快速评估器：7 张牌零分配整数编码（类别*13^4 + 踢脚），整型比较即牌力
   比较；翻前精确枚举 1.7M boards × N 玩家在浏览器主线程约 1~2s。
   ================================================================ */

import { parseCard } from "./poker";

const RANK_CHARS = "23456789TJQKA";

// ── 类型 ───────────────────────────────────────────────────────

/** 一手具体组合：两张牌 + 权重（pokerstove 的 CardDistribution 条目） */
export interface Combo {
  c1: number;
  c2: number;
  weight: number;
}

/** 解析后的玩家：combos=null 表示随机（等价 ps-eval 的 fill 行为） */
export interface ParsedPlayer {
  combos: Combo[] | null;
}

export interface PlayerStoveResult {
  equity: number;
  winPct: number;
  tiePct: number;
  losePct: number;
  /** 独赢份额（ps-eval 括号输出第 1 个数） */
  winShares: number;
  /** 平分份额累加（k 人平分各记 1/k，ps-eval 第 2 个数） */
  tieShares: number;
}

export interface StoveMeta {
  mode: "exact" | "montecarlo";
  /** 精确模式=穷举的 board 数；Monte Carlo=迭代次数 */
  total: number;
  elapsedMs: number;
  /** 每个玩家的组合数（随机=1326） */
  combosPerPlayer: number[];
}

export interface StoveOutcome {
  players: PlayerStoveResult[];
  meta: StoveMeta;
  /** 非空 = 本次计算没有产生任何有效发牌（组合完全重叠等），players 结果不可用 */
  error: string | null;
}

export interface StoveJob {
  mode: "exact" | "montecarlo";
  total: number;
  done: number;
  finished: boolean;
  /** 推进至多 units 个单元（board / 迭代），可多次调用分块执行 */
  step(units: number): void;
  result(): StoveOutcome;
}

export type ParseResult =
  | { ok: true; players: ParsedPlayer[]; board: number[]; dead: number[] }
  | { ok: false; error: string };

// ── 快速评估器 ─────────────────────────────────────────────────

// 顺子查找表：rankMask(13bit) → 顺子最高 rank+1（0=无顺子；A-5 轮子=4）
const STRAIGHT_TABLE = new Uint8Array(1 << 13);
for (let m = 0; m < 1 << 13; m++) {
  STRAIGHT_TABLE[m] = 0;
  for (let hi = 12; hi >= 4; hi--) {
    const need = 0b11111 << (hi - 4);
    if ((m & need) === need) {
      STRAIGHT_TABLE[m] = hi + 1;
      break;
    }
  }
  // A-5 轮子（A5432）：5 高
  if (STRAIGHT_TABLE[m] === 0) {
    const wheel = 0b1000000001111;
    if ((m & wheel) === wheel) STRAIGHT_TABLE[m] = 3 + 1;
  }
}

const rankCount = new Int32Array(13);
const suitCount = new Int32Array(4);
const suitMask = new Int32Array(4);

/** 整数编码：(((((cat*13+k0)*13+k1)*13+k2)*13+k3)*13+k4)，整型比较=牌力比较 */
function encode(cat: number, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0): number {
  return ((((cat * 13 + k0) * 13 + k1) * 13 + k2) * 13 + k3) * 13 + k4;
}

/** 5~7 张牌评估，返回可整型比较的牌力值（零临时分配） */
export function evalFast(cards: Int32Array | number[], n: number): number {
  rankCount.fill(0);
  suitCount.fill(0);
  suitMask.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c % 13;
    const s = (c / 13) | 0;
    rankCount[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // 同花（含同花顺）
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) {
      const m = suitMask[s];
      const sh = STRAIGHT_TABLE[m];
      if (sh !== 0) return encode(8, sh - 1);
      // 从类别位 5 起步（encode(5) 已含 5 层 13，再乘会溢出到同花顺之上）
      let k = 5;
      let cnt = 0;
      for (let r = 12; r >= 0 && cnt < 5; r--) {
        if (m & (1 << r)) {
          k = k * 13 + r;
          cnt++;
        }
      }
      return k;
    }
  }

  // 顺子
  const sh = STRAIGHT_TABLE[rankMask];
  if (sh !== 0) return encode(4, sh - 1);

  // 按重复张数分类（r 从高到低遍历，天然有序）
  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const c = rankCount[r];
    if (c === 4) quad = r;
    else if (c === 3) trips.push(r);
    else if (c === 2) pairs.push(r);
  }

  if (quad >= 0) {
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && rankCount[r] > 0) return encode(7, quad, r);
    }
  }
  if (trips.length >= 2) return encode(6, trips[0], trips[1]);
  if (trips.length === 1 && pairs.length >= 1) return encode(6, trips[0], pairs[0]);
  if (trips.length === 1) {
    const k: number[] = [];
    for (let r = 12; r >= 0 && k.length < 2; r--) {
      if (rankCount[r] === 1) k.push(r);
    }
    return encode(3, trips[0], k[0], k[1]);
  }
  if (pairs.length >= 2) {
    const k: number[] = [];
    for (let r = 12; r >= 0 && k.length < 1; r--) {
      if (rankCount[r] === 1) k.push(r);
    }
    return encode(2, pairs[0], pairs[1], k[0]);
  }
  if (pairs.length === 1) {
    const k: number[] = [];
    for (let r = 12; r >= 0 && k.length < 3; r--) {
      if (rankCount[r] === 1) k.push(r);
    }
    return encode(1, pairs[0], k[0], k[1], k[2]);
  }
  let k = encode(0);
  let cnt = 0;
  for (let r = 12; r >= 0 && cnt < 5; r--) {
    if (rankCount[r] > 0) {
      k = k * 13 + r;
      cnt++;
    }
  }
  return k;
}

// ── 输入解析 ───────────────────────────────────────────────────

const isRankChar = (ch: string) => RANK_CHARS.includes(ch.toUpperCase());

/** 拆分权重后缀：“AcAs=0.75” / “QQ:0.5” → [主体, 权重]。权重必须是合法浮点数（拒绝 “0.50.5” 这类畸形输入） */
function splitWeight(tok: string): { base: string; weight: number } | string {
  const m = tok.match(/^(.*?)[:=](\d+(?:\.\d+)?)$/);
  if (!m) return { base: tok, weight: 1 };
  const w = parseFloat(m[2]);
  if (!isFinite(w) || w <= 0 || w > 1) return `权重 “${m[2]}” 需在 (0,1] 内`;
  return { base: m[1], weight: w };
}

/** 花色两两组合的展开：suited 4 组合 / offsuit 12 组合 */
function expandSuitedClass(hi: number, lo: number, suited: boolean, weight: number): Combo[] {
  const out: Combo[] = [];
  if (suited) {
    for (let s = 0; s < 4; s++) out.push({ c1: s * 13 + hi, c2: s * 13 + lo, weight });
  } else {
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        out.push({ c1: a * 13 + hi, c2: b * 13 + lo, weight });
        out.push({ c1: b * 13 + hi, c2: a * 13 + lo, weight });
      }
    }
  }
  return out;
}

function expandPair(rank: number, weight: number): Combo[] {
  const out: Combo[] = [];
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) out.push({ c1: a * 13 + rank, c2: b * 13 + rank, weight });
  }
  return out;
}

/** 展开单个范围记号（不含权重后缀），如 QQ / QQ+ / AKs / ATs+ / 88-QQ / AJs-A5s */
function expandRangeToken(base: string, weight: number): Combo[] | string {
  let plus = false;
  let b = base;
  if (b.endsWith("+")) {
    plus = true;
    b = b.slice(0, -1);
  }

  if (b.includes("-")) {
    if (plus) return `范围 “${base}” 不支持区间再加 “+”`;
    const [spanA, spanB] = b.split("-");
    const side = (t: string): { hi: number; lo: number; suited: boolean | null } | string => {
      if (t.length >= 2 && t.length <= 3) {
        const r1 = RANK_CHARS.indexOf(t[0].toUpperCase());
        const r2 = RANK_CHARS.indexOf(t[1].toUpperCase());
        if (r1 === -1 || r2 === -1) return `无法识别 “${t}”`;
        const suited = t.length === 3 ? (t[2].toLowerCase() === "s" ? true : t[2].toLowerCase() === "o" ? false : null) : r1 === r2 ? null : null;
        if (t.length === 3 && suited === null) return `“${t}” 第 3 位需为 s 或 o`;
        return { hi: Math.max(r1, r2), lo: Math.min(r1, r2), suited };
      }
      return `无法识别 “${t}”`;
    };
    const A = side(spanA);
    const B = side(spanB);
    if (typeof A === "string") return A;
    if (typeof B === "string") return B;
    const loSide = A.hi < B.hi ? A : B;
    const hiSide = A.hi < B.hi ? B : A;
    if (loSide.hi === loSide.lo && hiSide.hi === hiSide.lo) {
      const out: Combo[] = [];
      for (let r = loSide.hi; r <= hiSide.hi; r++) out.push(...expandPair(r, weight));
      return out;
    }
    if (loSide.hi !== hiSide.hi || loSide.suited !== hiSide.suited || loSide.suited === null) {
      return `范围 “${base}” 两端需为同花色类别且高牌相同（如 AJs-A5s）`;
    }
    const out: Combo[] = [];
    const lo0 = Math.min(loSide.lo, hiSide.lo);
    const lo1 = Math.max(loSide.lo, hiSide.lo);
    for (let lo = lo0; lo <= lo1; lo++) {
      out.push(...expandSuitedClass(loSide.hi, lo, loSide.suited, weight));
    }
    return out;
  }

  if (b.length === 3 && (b[2] === "s" || b[2] === "o" || b[2] === "S" || b[2] === "O")) {
    const r1 = RANK_CHARS.indexOf(b[0].toUpperCase());
    const r2 = RANK_CHARS.indexOf(b[1].toUpperCase());
    if (r1 === -1 || r2 === -1 || r1 === r2) return `无法识别 “${base}”`;
    const suited = b[2].toLowerCase() === "s";
    const hi = Math.max(r1, r2);
    const lo = Math.min(r1, r2);
    // “ATs+” 高牌锚定、踢脚上抬：{ATs, AJs, AQs, AKs}（PokerStove/Equilab 语义）
    if (plus) {
      const out: Combo[] = [];
      for (let l = lo; l < hi; l++) out.push(...expandSuitedClass(hi, l, suited, weight));
      return out;
    }
    return expandSuitedClass(hi, lo, suited, weight);
  }

  if (b.length === 2) {
    const r1 = RANK_CHARS.indexOf(b[0].toUpperCase());
    const r2 = RANK_CHARS.indexOf(b[1].toUpperCase());
    if (r1 === -1 || r2 === -1) return `无法识别 “${base}”`;
    if (r1 === r2) {
      if (!plus) return expandPair(r1, weight);
      const out: Combo[] = [];
      for (let r = r1; r <= 12; r++) out.push(...expandPair(r, weight));
      return out;
    }
    // “AK” 视作 offsuit + suited？pokerstove 无此写法；要求明确 s/o
    return `“${base}” 需写明同花/杂色：${base}s 或 ${base}o`;
  }

  return `无法识别 “${base}”`;
}

/** 解析单个玩家的输入文本 → 组合列表；空文本 = 随机（null） */
export function parsePlayerInput(text: string): { combos: Combo[] | null } | string {
  const trimmed = text.trim();
  if (!trimmed) return { combos: null };

  // 拆记号；连续两个 2 字符牌张记号合并为一个组合（兼容 “Ac As” 写法）
  const tokens = trimmed.split(/[,\s]+/).filter(Boolean);
  const combos: Combo[] = [];
  let pending: { card: string; weight: number } | null = null;

  for (const tok of tokens) {
    const sw = splitWeight(tok);
    if (typeof sw === "string") return sw;
    const { base, weight } = sw;

    if (base.length === 4 && isRankChar(base[0]) && !base.includes("-") && !base.endsWith("+")) {
      const c1 = parseCard(base.slice(0, 2));
      const c2 = parseCard(base.slice(2, 4));
      if (c1 < 0 || c2 < 0) return `无法识别 “${tok}”`;
      if (c1 === c2) return `“${tok}” 出现重复牌`;
      pending = null;
      combos.push({ c1, c2, weight });
      continue;
    }
    if (base.length === 2 && parseCard(base) >= 0 && RANK_CHARS.indexOf(base[0].toUpperCase()) !== RANK_CHARS.indexOf(base[1].toUpperCase())) {
      // 2 字符具体牌张（非对子记号）；拆写的两张取权重乘积（通常只有一张带权重）
      if (pending !== null) {
        const c1 = parseCard(pending.card);
        const c2 = parseCard(base);
        if (c1 === c2) return `“${pending.card}${base}” 出现重复牌`;
        const w = pending.weight * weight;
        pending = null;
        combos.push({ c1, c2, weight: w });
      } else {
        pending = { card: base, weight };
      }
      continue;
    }
    // 其余按范围记号处理（QQ / AKs / QQ+ / 88-QQ / ATs+:0.5 …）
    if (pending !== null) return `“${pending}” 后跟 “${tok}” 无法组成完整手牌`;
    const expanded = expandRangeToken(base, weight);
    if (typeof expanded === "string") return expanded;
    if (expanded.length === 0) return `“${tok}” 未展开出任何组合`;
    combos.push(...expanded);
  }

  if (pending !== null) return `末尾的 “${pending.card}” 缺少第二张牌`;
  if (combos.length === 0) return `输入 “${text}” 未解析出任何组合`;

  // 去重（同组合重复出现按权重叠加没有意义，直接报错）
  const seen = new Set<string>();
  for (const c of combos) {
    const key = c.c1 < c.c2 ? `${c.c1}-${c.c2}` : `${c.c2}-${c.c1}`;
    if (seen.has(key)) return `组合重复：${cardPairStr(c.c1, c.c2)}`;
    seen.add(key);
  }
  return { combos };
}

function cardPairStr(c1: number, c2: number): string {
  const ch = (c: number) => RANK_CHARS[c % 13] + "shdc"[Math.floor(c / 13)];
  return ch(c1) + ch(c2);
}

/** 解析公共牌 5 格 / 死牌文本 → 牌号数组（过滤空格） */
function parseCardList(texts: string[]): { cards: number[] } | string {
  const cards: number[] = [];
  const tokens = texts.flatMap((t) => t.split(/[,\s]+/)).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length !== 2) return `“${tok}” 不是合法的牌（需 2 字符，如 As）`;
    const c = parseCard(tok);
    if (c < 0) return `无法识别 “${tok}”`;
    if (cards.includes(c)) return `重复牌：${tok.toUpperCase()}`;
    cards.push(c);
  }
  return { cards };
}

/**
 * 解析全部输入。玩家留空 = 随机（1326 组合）。
 * 范围玩家会剔除与公共牌/死牌/他人确定手牌冲突的组合（pokerstove 跳过重叠元组语义）。
 */
export function parseStoveInputs(
  playerTexts: string[],
  boardTexts: string[],
  deadText: string,
): ParseResult {
  if (playerTexts.length < 2) return { ok: false, error: "至少需要 2 名玩家" };

  const players: ParsedPlayer[] = [];
  for (let i = 0; i < playerTexts.length; i++) {
    const r = parsePlayerInput(playerTexts[i]);
    if (typeof r === "string") return { ok: false, error: `玩家 ${i + 1}：${r}` };
    players.push(r);
  }

  const boardR = parseCardList(boardTexts);
  if (typeof boardR === "string") return { ok: false, error: `公共牌：${boardR}` };
  const board = boardR.cards;
  if (board.length > 5) return { ok: false, error: "公共牌最多 5 张" };

  const deadR = parseCardList([deadText]);
  if (typeof deadR === "string") return { ok: false, error: `死牌：${deadR}` };
  const dead = deadR.cards;

  // 范围玩家剔除与 公共牌/死牌/他人确定手牌 冲突的组合
  //（单组合玩家自身不过滤，其与其他输入的冲突由下方查重负责）
  const singleCards: number[][] = players.map((p) =>
    p.combos && p.combos.length === 1 ? [p.combos[0].c1, p.combos[0].c2] : [],
  );
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.combos || p.combos.length === 1) continue;
    const banned = [...board, ...dead];
    for (let j = 0; j < players.length; j++) {
      if (j !== i) banned.push(...singleCards[j]);
    }
    p.combos = p.combos.filter((c) => !banned.includes(c.c1) && !banned.includes(c.c2));
    if (p.combos.length === 0) {
      return { ok: false, error: `玩家 ${i + 1}：范围与公共牌/死牌/他人手牌完全冲突` };
    }
  }

  // 确定手牌之间的重复检查（含范围玩家的“唯一组合”情形）
  const seenCards = new Map<number, string>();
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.combos || p.combos.length !== 1) continue;
    for (const c of [p.combos[0].c1, p.combos[0].c2]) {
      const where = seenCards.get(c);
      if (where !== undefined) {
        return { ok: false, error: `玩家 ${i + 1} 与 ${where} 的牌重复` };
      }
      seenCards.set(c, `玩家 ${i + 1}`);
    }
  }
  for (const c of board) {
    if (seenCards.has(c)) return { ok: false, error: "手牌与公共牌重复" };
    seenCards.set(c, "公共牌");
  }
  for (const c of dead) {
    if (seenCards.has(c)) return { ok: false, error: "死牌与其他输入重复" };
    seenCards.set(c, "死牌");
  }

  // 剩余牌必须够发完公共牌，且每个非具体手牌玩家还能各拿 2 张
  const known = new Set<number>(seenCards.keys());
  const drawPlayers = players.filter((p) => !p.combos || p.combos.length > 1).length;
  const remaining = 52 - known.size;
  const needCards = 2 * drawPlayers + (5 - board.length);
  if (remaining < needCards) {
    return {
      ok: false,
      error: `剩余牌不足：扣除手牌/公共牌/死牌后只剩 ${remaining} 张，无法发完公共牌并给 ${drawPlayers} 名待定玩家各发 2 张（共需 ${needCards} 张）`,
    };
  }

  return { ok: true, players, board, dead };
}

// ── 计算任务 ───────────────────────────────────────────────────

const MAX_EXACT_TALLIES = 2_000_000; // 精确模式预算：组合元组数 × board 数（翻前单挑 1.71M 必须放行；范围组合一律超限走 MC）

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

interface Acc {
  win: number;
  tie: number;
}

/** showdown 计票（移植 evaluateShowdown：独赢 +w；k 人平分各 +w/k） */
function tally(evals: Int32Array, n: number, weight: number, acc: Acc[]): void {
  let best = evals[0];
  for (let i = 1; i < n; i++) {
    if (evals[i] > best) best = evals[i];
  }
  let winners = 0;
  for (let i = 0; i < n; i++) {
    if (evals[i] === best) winners++;
  }
  if (winners === 1) {
    for (let i = 0; i < n; i++) {
      if (evals[i] === best) {
        acc[i].win += weight;
        break;
      }
    }
  } else {
    const share = weight / winners;
    for (let i = 0; i < n; i++) {
      if (evals[i] === best) acc[i].tie += share;
    }
  }
}

/**
 * 创建 equity 计算任务。
 * - 所有玩家均为单一具体组合且组合元组数 × board 数在预算内 → 精确穷举
 * - 否则 Monte Carlo（opts.runs 默认 200,000）
 * 用法：循环调用 step()（每帧给 8~12ms 的量），直到 finished，再取 result()。
 */
export function createStoveJob(
  players: ParsedPlayer[],
  board: number[],
  dead: number[],
  opts?: { runs?: number },
): StoveJob {
  if (players.length < 2) throw new Error("至少需要 2 名玩家");
  const n = players.length;

  const combosPerPlayer = players.map((p) => (p.combos ? p.combos.length : 1326));
  const tupleProduct = players.reduce((a, p) => a * (p.combos ? p.combos.length : Infinity), 1);

  const used = new Set<number>([...board, ...dead]);
  for (const p of players) {
    if (p.combos && p.combos.length === 1) {
      used.add(p.combos[0].c1);
      used.add(p.combos[0].c2);
    }
  }
  const deck0: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck0.push(c);

  const need = 5 - board.length;
  const nMulti = players.filter((p) => p.combos !== null && p.combos.length > 1).length;
  const availLen = deck0.length - 2 * nMulti; // 每个元组的剩余 deck（多组合玩家的牌在元组内排除）
  const boardCount = binomial(availLen, need);
  const exact = players.every((p) => p.combos !== null) && tupleProduct * boardCount <= MAX_EXACT_TALLIES;

  const acc: Acc[] = players.map(() => ({ win: 0, tie: 0 }));
  let done = 0;
  let finished = false;
  let elapsedMs = 0;
  let jobError: string | null = null;
  // 进度口径：被跳过的单元（重叠元组/采样失败）也计入 done，保证进度条能到 100%
  let skippedTuples = 0; // 精确模式：因重叠被跳过的组合元组数
  let failedSamples = 0; // MC：因冲突被放弃的采样次数
  let total: number;
  let stepFn: (units: number) => void;

  const bufs: Int32Array[] = players.map(() => new Int32Array(7));
  // 预填已知公共牌：评估缓冲布局 [hole0, hole1, board0..board4]
  for (const buf of bufs) {
    for (let i = 0; i < board.length; i++) buf[2 + i] = board[i];
  }
  const evals = new Int32Array(n);
  const boardBuf = new Int32Array(5);

  if (exact) {
    // ── 精确模式：Odometer（组合元组笛卡尔积，重叠元组按 pokerstove 语义跳过）
    //    × 每元组在其剩余 deck 上做字典序 board 组合（combinations::next，可断点续跑）──
    total = boardCount * tupleProduct;
    const comboIdx = new Int32Array(n); // 每个玩家当前组合下标
    const iter = players.map((p) => p.combos!.length);

    const idx = new Int32Array(need);
    const avail: number[] = [];
    const off = 2 + board.length;
    let started = false;

    /** 装载 comboIdx 指向的元组：重叠（同牌出现在多个玩家）→ false，否则构建 avail 并复位 idx */
    const loadTuple = (): boolean => {
      const cards: number[] = [];
      for (let p = 0; p < n; p++) {
        const c = players[p].combos![comboIdx[p]];
        cards.push(c.c1, c.c2);
      }
      if (new Set(cards).size !== cards.length) return false;
      avail.length = 0;
      for (const c of deck0) if (!cards.includes(c)) avail.push(c);
      for (let i = 0; i < need; i++) idx[i] = i;
      return true;
    };

    /** 组合元组 odometer 前进；全部穷尽 → false */
    const scrollTuple = (): boolean => {
      let k = n - 1;
      while (k >= 0) {
        comboIdx[k]++;
        if (comboIdx[k] < iter[k]) return true;
        comboIdx[k] = 0;
        k--;
      }
      return false;
    };

    /** 跳过重叠元组地装载；全部穷尽 → false */
    const startTuple = (): boolean => {
      for (;;) {
        if (loadTuple()) return true;
        skippedTuples++;
        if (!scrollTuple()) return false;
      }
    };

    stepFn = (units: number) => {
      if (finished) return;
      const t0 = performance.now();
      for (let u = 0; u < units; u++) {
        // 推进到下一个待计票 board
        for (;;) {
          if (!started) {
            started = true;
            if (!startTuple()) {
              finished = true;
              jobError = "组合之间完全重叠（玩家间/与公共牌·死牌冲突），没有任何合法发牌";
            }
            break;
          }
          let j = need - 1;
          while (j >= 0 && idx[j] === avail.length - need + j) j--;
          if (j >= 0) {
            idx[j]++;
            for (let m = j + 1; m < need; m++) idx[m] = idx[m - 1] + 1;
            break;
          }
          // 当前元组 board 穷尽 → 下一个元组（新元组的首个 board 落在 break 后计票）
          if (!scrollTuple()) {
            finished = true;
            break;
          }
          if (!startTuple()) {
            finished = true;
            break;
          }
          break;
        }
        if (finished) break;

        for (let i = 0; i < need; i++) boardBuf[i] = avail[idx[i]];
        for (let p = 0; p < n; p++) {
          const combo = players[p].combos![comboIdx[p]];
          const buf = bufs[p];
          buf[0] = combo.c1;
          buf[1] = combo.c2;
          for (let i = 0; i < need; i++) buf[off + i] = boardBuf[i];
          evals[p] = evalFast(buf, 7);
        }
        let weight = 1;
        for (let p = 0; p < n; p++) weight *= players[p].combos![comboIdx[p]].weight;
        tally(evals, n, weight, acc);
        done++;
      }
      elapsedMs += performance.now() - t0;
      if (done >= total) finished = true;
    };
  } else {
    // ── Monte Carlo：按权重采样组合 + 采样补板（pokerstove 无此模式，语义对齐） ──
    total = opts?.runs ?? 200_000;

    // 每个范围玩家的累计权重表（parseStoveInputs 已剔除与 board/dead 冲突的组合）
    const weighted = players.map((p) => {
      if (!p.combos) return null;
      const cum = new Float64Array(p.combos.length);
      let sum = 0;
      for (let i = 0; i < p.combos.length; i++) {
        sum += p.combos[i].weight;
        cum[i] = sum;
      }
      return { cum, sum };
    });
    const sampledIdx = new Int32Array(n);

    const sampleCombo = (p: number): number => {
      const w = weighted[p]!;
      const x = Math.random() * w.sum;
      let lo = 0;
      let hi = w.cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (w.cum[mid] <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    stepFn = (units: number) => {
      if (finished) return;
      const t0 = performance.now();
      let consecutiveFails = 0;
      const failSample = () => {
        failedSamples++;
        consecutiveFails++;
        // 采样连续失败说明组合重叠到几乎无合法发牌，必须终止而不是空转
        if (consecutiveFails > 64) {
          finished = true;
          jobError = "组合重叠过多：连续多次采样均无合法发牌，请检查各玩家范围/死牌";
        }
      };
      for (let u = 0; u < units; u++) {
        // 1. 采样范围玩家（互相冲突则重试，超过次数放弃本轮）
        const sampled: (number[] | null)[] = new Array(n).fill(null);
        const usedCards = new Set<number>(board);
        for (const c of dead) usedCards.add(c);
        let ok = true;
        for (let p = 0; p < n; p++) {
          if (!players[p].combos) continue;
          let picked: Combo | null = null;
          for (let t = 0; t < 8; t++) {
            const ci = sampleCombo(p);
            const combo = players[p].combos![ci];
            if (!usedCards.has(combo.c1) && !usedCards.has(combo.c2)) {
              picked = combo;
              sampledIdx[p] = ci;
              break;
            }
          }
          if (!picked) {
            ok = false;
            break;
          }
          sampled[p] = [picked.c1, picked.c2];
          usedCards.add(picked.c1);
          usedCards.add(picked.c2);
        }
        if (!ok) {
          failSample(); // 极罕见：范围几乎全冲突
          continue;
        }

        // 2. 从剩余 deck 采样 board + 随机玩家底牌（partial Fisher-Yates）
        const pool: number[] = [];
        for (const c of deck0) if (!usedCards.has(c)) pool.push(c);
        const nullPlayers: number[] = [];
        for (let p = 0; p < n; p++) if (players[p].combos === null) nullPlayers.push(p);
        const drawK = need + nullPlayers.length * 2;
        if (pool.length < drawK) {
          failSample(); // parseStoveInputs 已校验总量，此处仅为防御
          continue;
        }
        for (let i = 0; i < drawK; i++) {
          const j = i + Math.floor(Math.random() * (pool.length - i));
          const t = pool[i];
          pool[i] = pool[j];
          pool[j] = t;
        }
        for (let i = 0; i < need; i++) boardBuf[i] = pool[i];
        for (let k = 0; k < nullPlayers.length; k++) {
          const p = nullPlayers[k];
          sampled[p] = [pool[need + k * 2], pool[need + k * 2 + 1]];
        }

        // 3. 计票
        const off = 2 + board.length;
        for (let p = 0; p < n; p++) {
          const buf = bufs[p];
          const hole = sampled[p]!;
          buf[0] = hole[0];
          buf[1] = hole[1];
          for (let i = 0; i < need; i++) buf[off + i] = boardBuf[i];
          evals[p] = evalFast(buf, 7);
        }
        let weight = 1;
        for (let p = 0; p < n; p++) {
          if (weighted[p]) weight *= players[p].combos![sampledIdx[p]].weight;
        }
        tally(evals, n, weight, acc);
        done++;
        consecutiveFails = 0;
      }
      elapsedMs += performance.now() - t0;
      if (done >= total) finished = true;
    };
  }

  return {
    mode: exact ? "exact" : "montecarlo",
    total,
    get done() {
      // 被跳过的单元（重叠元组 / 失败采样）计入进度，使 done 能追上 total
      return done + (exact ? skippedTuples * boardCount : failedSamples);
    },
    get finished() {
      return finished;
    },
    step: stepFn,
    result(): StoveOutcome {
      let sum = 0;
      for (const a of acc) sum += a.win + a.tie;
      const playersOut: PlayerStoveResult[] = acc.map((a) => {
        const equity = sum > 0 ? (a.win + a.tie) / sum : 0;
        return {
          equity,
          winPct: sum > 0 ? a.win / sum : 0,
          tiePct: sum > 0 ? a.tie / sum : 0,
          losePct: sum > 0 ? 1 - (a.win + a.tie) / sum : 0,
          winShares: a.win,
          tieShares: a.tie,
        };
      });
      return {
        players: playersOut,
        meta: { mode: exact ? "exact" : "montecarlo", total, elapsedMs, combosPerPlayer },
        error: jobError ?? (sum === 0 ? "无任何合法发牌（组合重叠冲突）" : null),
      };
    },
  };
}
