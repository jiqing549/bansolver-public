/* ================================================================
   GGPoker Hand History Parser
   ================================================================

   数据流：
     raw text ──parseGGHandHistory()──▶ ParsedHand[]
                                            │
                              ┌─────────────┼──────────────┐
                              ▼             ▼              ▼
                       computeStats()  computeLuckStats()  ban2note 曲线/卡片
                       (HM3/PT4 stats) (起手牌+成牌运气)

   核心规则 ── 投入金额的 SET/ADD 语义（决定盈亏准确性）：
     • "posts blind"      → SET 为盲注额（重置，因为盲注是强制的起始投入）
     • "raises $X to $Y"  → SET 为 $Y（"to" = 本街总投入，不是加注增量）
     • "calls $X"         → ADD $X（跟注是额外投入）
     • "bets $X"          → ADD $X（新街首次下注）
     • "posts the ante"   → ADD（ante 是额外强制投入）

   统计指标定义见 docs/BAN2NOTE_PARSER_SPEC.md，bug 修复历史见
   docs/BAN2NOTE_SECOND_AUDIT_2026-06-16.md（勿删 worker/sample-large.txt，
   它是回归验证基准样本，7213 手）。

   ★★★ 防泄漏边界（2026-10-26）★★★
   本文件 = 解析器核心，服务端专属（functions/api/parse.ts 与 node
   回归脚本引用）。前端代码只允许 import hhTypes/hhEv/hhStats，
   禁止直接 import 本文件——否则解析 know-how 重新进前端 bundle。
   上线后用 out/_next chunks grep 特征串验收（见 scripts/verify-no-parse-in-bundle.mjs）。
   ================================================ */

import { evaluate, parseCard, compareRanks } from "./poker";
import { computeAllInEquityNway } from "./equity";
import { isCoinPokerHistory, coinpokerToGG } from "./coinpoker";
import {
  type StreetActionSnapshot,
  type ParsedHand,
  type StreetAggStats,
  type SessionStats,
  type RawRange,
} from "./hhTypes";
import { solveEvPlan, type EvPlan } from "./hhEv";
import { computeStats, computeLuckStats } from "./hhStats";

// 共享类型与客户端模块从这里 re-export：node 回归脚本沿用旧入口
// （loadTsModule("src/lib/handHistory.ts")）不受切割影响。
export { solveEvPlan } from "./hhEv";
export type { EvPlan } from "./hhEv";
export { computeStats, computeLuckStats } from "./hhStats";
export type {
  StreetActionSnapshot,
  ParsedHand,
  StreetAggStats,
  SessionStats,
  RawRange,
} from "./hhTypes";
export type { PremiumFreqStat, StreetTwoPairStat, LuckStats } from "./hhStats";

// Helper: parse dollar string with possible commas (e.g. "$1,131.50")
function $(s: string): number { return parseFloat(s.replace(/,/g, '')); }

function timestampOf(date: string): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(date.replace(/\//g, "-"));
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function sumWinningAmounts(line: string): number {
  let total = 0;
  for (const m of line.matchAll(/won\s*\(\$([\d.,]+)\)/g)) total += $(m[1]);
  for (const m of line.matchAll(/collected\s*\(\$([\d.,]+)\)/g)) total += $(m[1]);
  for (const m of line.matchAll(/collected\s+\$([\d.,]+)/g)) total += $(m[1]);
  return total;
}

function parseActionLine(line: string): { actor: string; action: string } | null {
  const match = line.match(/^(.+?):\s*(.*)$/);
  if (!match) return null;
  return { actor: match[1], action: match[2] };
}

// Extract the owning player name from a single hand-history line, so we never rely on
// `line.includes(playerName)` (which lets "Hero" match "Hero2"). Returns null if the line
// has no owner token we recognize.
//
// Line shapes we support:
//   "Seat N: NAME (button) showed ..."   -> NAME   (SUMMARY seat line)
//   "NAME: bets $2"                       -> NAME   (action line; ":" then space)
//   "NAME collected $2.50 from pot"       -> NAME   (SHOWDOWN collected, no colon)
//   "NAME showed [As Ah]"                 -> NAME   (SHOWDOWN showed, no colon)
//   "Uncalled bet ($9.81) returned to NAME" -> NAME (refund line)
function ownerOfLine(line: string): string | null {
  // SUMMARY seat line: "Seat N: NAME ..."
  let m = line.match(/^Seat\s+\d+:\s+(\S+)/);
  if (m) return m[1];
  // Action / showdown line with "NAME: ..." or "NAME collected/showed ..."
  // The owner is the leading token up to the first ":" or whitespace.
  m = line.match(/^(\S+?):\s/);
  if (m) return m[1];
  // "NAME collected $x ..." / "NAME showed [...]" (no colon) — owner = first token.
  if (/^\S+\s+(collected|showed|shows|mucks|mucked)\b/.test(line)) {
    m = line.match(/^(\S+)/);
    if (m) return m[1];
  }
  // "Uncalled bet ($x) returned to NAME"
  m = line.match(/returned to\s+(\S+)\s*$/);
  if (m) return m[1];
  return null;
}

// Single street postflop action snapshot (batch 3)

// Auto-detect the most frequent player ID from hand history
export function detectPlayerName(text: string): string | null {
  const counts = new Map<string, number>();
  // 只锚定筹码格式座位行（"Seat N: NAME ($…"）：名字段排除括号字符，防止
  // SUMMARY 行 "Seat N: NAME (small blind) collected ($x)" 被整段当名字捕获；
  // 取首个 " (" 前的完整名字，支持带空格的名字；单 token 名与旧 \S+ 结果一致。
  const regex = /Seat \d+: ([^()]+?) \(\$/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const name = m[1];
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}


// 精简批量入口：切手→逐手解析→去重→按时间排序，不算 stats、不拼 dedupedText
// （Worker 分批解析用；与 parseGGHandHistory 的解析结果完全一致）
// rawRanges：传入数组时改为「位置模式」——不回填 h.raw（留空串），把每手原文
// 在 text 里的 [start,end) 区间按 id 推入数组。调用方（/api/parse）拿它省掉
// 响应里的原文重复传输；客户端持有原文自行 slice。不传时行为与旧版完全一致。
export function parseHandsChunk(
  text: string,
  playerName = "Hero",
  evOut?: { plans: EvPlan[] },
  rawRanges?: RawRange[],
): {
  hands: ParsedHand[];
  duplicateHands: number;
} {
  // CoinPoker 牌谱：入口处转译成 GG 同构文本（见 coinpoker.ts），
  // 之后走完全相同的 GG 管线；GG 文本不经过转译，零影响。
  const normalized = isCoinPokerHistory(text) ? coinpokerToGG(text) : text;
  // GG 导出偶发把小数点写成 NUL/退格（bets $0␀05 应为 $0.05，实测样本 RC4794780246，
  // 96 万手里 river bet/raise 行 5.77 万手命中）。与回放解析器 handReplay.ts 同口径：
  // 数字之间的 NUL/退格还原为小数点，其余剥除。必须在切分前对全文做——此前只在
  // 翻后行动行做「删除式」清洗，hero 金额被放大 100 倍，对手翻前行与 SUMMARY
  // 收池行则完全没清洗、金额在 NUL 处截断归零（2026-11-03 全站审查 P0）。
  const sane = normalized
    .replace(/(\d)\u0000(\d)/g, "$1.$2")
    .replace(/(\d)\x08(\d)/g, "$1.$2")
    .replace(/[\u0000\x08]/g, "");
  const rawHands = sane.split(/[\r\n]+(?=Poker(?:Stars Zoom)? Hand #)/);

  // 位置模式：预计算每块在 sane 里的起点（与 split 的切分严格一致）
  const chunkStarts: number[] | null = rawRanges ? [0] : null;
  if (chunkStarts) {
    const re = /[\r\n]+(?=Poker(?:Stars Zoom)? Hand #)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sane)) !== null) chunkStarts.push(m.index + m[0].length);
  }

  // Auto-detect player name if "Hero" not found
  let detectedName = playerName;
  if (playerName === "Hero") {
    const hasHero = sane.includes("Hero");
    if (!hasHero) {
      detectedName = detectPlayerName(text) || "Hero";
    }
  }

  const byId = new Map<string, ParsedHand>();
  const rawById = new Map<string, string>();
  const orderById = new Map<string, number>();
  let duplicateHands = 0;
  for (let sourceIndex = 0; sourceIndex < rawHands.length; sourceIndex++) {
    const raw = rawHands[sourceIndex];
    if (!raw.trim()) continue;
    const h = parseSingleHand(raw, detectedName, evOut);
    if (!h) continue;
    if (byId.has(h.id)) {
      duplicateHands++;
      continue;
    }
    byId.set(h.id, h);
    rawById.set(h.id, raw.trim());
    if (rawRanges && chunkStarts) {
      const chunkStart = chunkStarts[sourceIndex] ?? 0;
      const trimmed = raw.trim();
      const start = chunkStart + (raw.length - raw.trimStart().length);
      rawRanges.push({ id: h.id, start, end: start + trimmed.length });
    }
    orderById.set(h.id, sourceIndex);
  }

  const hands = [...byId.values()].sort((a, b) => {
    const byDate = timestampOf(a.date) - timestampOf(b.date);
    if (byDate !== 0) return byDate;
    return (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0);
  });
  if (!rawRanges) for (const h of hands) h.raw = rawById.get(h.id) ?? "";
  return { hands, duplicateHands };
}

export function parseGGHandHistory(text: string, playerName = "Hero"): {
  hands: ParsedHand[];
  stats: SessionStats;
  duplicateHands: number;
  dedupedText: string;
} {
  const { hands, duplicateHands } = parseHandsChunk(text, playerName);
  const dedupedText = hands.map((h) => h.raw).join("\n\n");
  return { hands, stats: computeStats(hands), duplicateHands, dedupedText };
}

// 从按钮座位号、活跃座位、Hero座位号推算 Hero 的位置名
// 行动顺序 = 按钮后第一个活跃座位开始环绕；第1=SB,第2=BB,其余按桌型映射
function computeHeroPosition(
  seatNumbers: number[],
  buttonSeat: number,
  heroSeat: number,
  tableSize: number,
): string {
  const n = seatNumbers.length;
  if (n < 2) return "";

  // 构建行动顺序：从按钮+1开始环绕，跳过空座
  // seatNumbers 已升序；找到按钮在数组中的索引，下一格开始
  const btnIdx = seatNumbers.indexOf(buttonSeat);
  if (btnIdx < 0) return ""; // 按钮座位不在活跃列表里（异常）

  // 行动顺序数组（座位号）
  const order: number[] = [];
  for (let i = 1; i <= n; i++) {
    order.push(seatNumbers[(btnIdx + i) % n]);
  }

  // 找 Hero 在行动顺序中的位置（0-indexed）
  const heroOrderIdx = order.indexOf(heroSeat);

  // GGPoker heads-up(2人)：按钮位=SB，另一玩家=BB
  // order 只含 button+1（即非按钮玩家=BB）；按钮玩家不在 order 中
  if (n === 2) {
    if (heroSeat === buttonSeat) return "SB";
    return heroOrderIdx === 0 ? "BB" : "";
  }

  if (heroOrderIdx < 0) return "";

  // order[0]=SB, order[1]=BB, order[n-1]=BTN
  if (heroOrderIdx === 0) return "SB";
  if (heroOrderIdx === 1) return "BB";
  if (heroOrderIdx === n - 1) return "BTN";

  // 中间位置（order[2]..order[n-2]），即翻前首先行动到最后行动（BTN前）
  // 翻前行动数 = n - 3（去掉 SB/BB/BTN）
  const preflopActors = n - 3; // 中间位置个数
  const heroPreflopRank = heroOrderIdx - 2; // 0=首先行动
  // 按行动人数选择标签集（从最早行动到最晚）
  // 9人桌中间6个：UTG, UTG+1, UTG+2, MP, HJ, CO
  // 8人桌中间5个：UTG, UTG+1, MP, HJ, CO
  // 7人桌中间4个：UTG, MP, HJ, CO
  // 6人桌中间3个：UTG, MP, CO
  // 短桌按实际人数映射
  let middleLabels: string[];
  if (preflopActors <= 0) return "BTN";
  if (preflopActors === 6) {
    middleLabels = ["UTG", "UTG+1", "UTG+2", "MP", "HJ", "CO"];
  } else if (preflopActors === 5) {
    middleLabels = ["UTG", "UTG+1", "MP", "HJ", "CO"];
  } else if (preflopActors === 4) {
    middleLabels = ["UTG", "MP", "HJ", "CO"];
  } else if (preflopActors === 3) {
    middleLabels = ["UTG", "MP", "CO"];
  } else if (preflopActors === 2) {
    middleLabels = ["UTG", "CO"];
  } else {
    middleLabels = ["CO"];
  }
  return middleLabels[heroPreflopRank] ?? "";
}

// hero absolute position → IP/OOP for postflop (batch 3)
// IP/OOP by relative action order (batch 3)
// Compares hero vs the last preflop aggressor in postflop action order.
// IP/OOP by relative action order (batch 3)
// Compares hero vs the "opponent reference" in postflop action order.
// - hero is raiser: reference = last caller
// - hero is caller: reference = last raiser (aggressor)
// Action order: SB acts first = OOP, BTN acts last = IP.
function heroIsIP(
  heroSeat: number,
  aggressorSeat: number | null,
  lastCallerSeat: number | null,
  seatNumbers: number[],
  buttonSeat: number,
): boolean | null {
  // Pick reference: if hero is the aggressor, compare vs last caller; else vs aggressor
  const ref = (aggressorSeat === heroSeat) ? lastCallerSeat : aggressorSeat;
  if (ref === null || ref === heroSeat) return null;
  const n = seatNumbers.length;
  const btnIdx = seatNumbers.indexOf(buttonSeat);
  if (btnIdx < 0) return null;
  const orderIdx = (seat: number) => {
    const idx = seatNumbers.indexOf(seat);
    if (idx < 0) return -1;
    return ((idx - btnIdx - 1) % n + n) % n;
  };
  const heroOrder = orderIdx(heroSeat);
  const refOrder = orderIdx(ref);
  if (heroOrder < 0 || refOrder < 0) return null;
  return heroOrder > refOrder;
}

// Analyze a single street's action sequence into a snapshot (batch 3)
function analyzeStreet(
  acts: { actor: string; isHero: boolean; act: string }[],
  isIP: boolean | null,
  isAggressor: boolean,
  heroCalledPriorStreet: boolean,
): StreetActionSnapshot {
  const snap: StreetActionSnapshot = {
    sawStreet: acts.some(a => a.isHero),
    isAggressor,
    isIP,
    cbetOpp: isAggressor && acts.length > 0,
    didCbet: false,
    facingCbet: false,
    didFoldVsCbet: false,
    didCallVsCbet: false,
    betOrRaise: false,
    heroFirstBettor: false,
    heroCalledPriorStreet,
    facingBet: false,
    foldedToBet: false,
    calledBet: false,
    raisedBet: false,
    checkedThenFacedBet: false,
    didCheckCall: false,
    didCheckRaise: false,
    betCount: 0,
    raiseCount: 0,
    callCount: 0,
    checkCount: 0,
  };
  if (acts.length === 0) return snap;

  // Find the first bettor on this street and whether it's hero
  let firstBettorIdx = -1;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i].act;
    if (a.startsWith("bets") || a.startsWith("raises") || a.startsWith("Bet & Muck")) {
      firstBettorIdx = i;
      break;
    }
  }
  // Hero was the first to bet/raise this street
  if (firstBettorIdx >= 0 && acts[firstBettorIdx].isHero) {
    snap.heroFirstBettor = true;
  }

  // CBet: hero is preflop raiser and bet this street
  if (isAggressor && firstBettorIdx >= 0 && acts[firstBettorIdx].isHero) {
    snap.didCbet = true;
  }

  // FvCB: hero is NOT preflop raiser, opponent (the raiser) bet first = c-bet
  // Only counts if hero is still in the hand (has a response action after the bet)
  if (!isAggressor && firstBettorIdx >= 0 && !acts[firstBettorIdx].isHero) {
    // Find hero's response after the c-bet
    let heroResponse: string | null = null;
    for (let i = firstBettorIdx + 1; i < acts.length; i++) {
      if (acts[i].isHero) {
        heroResponse = acts[i].act;
        break;
      }
    }
    // Only count as opportunity if hero actually responded (still in hand)
    if (heroResponse !== null) {
      snap.facingCbet = true;
      if (heroResponse.startsWith("folds")) snap.didFoldVsCbet = true;
      else if (heroResponse.startsWith("calls")) snap.didCallVsCbet = true;
    }
  }

  // Track whether hero faced a bet before each of hero's actions
  let oppBetPending = false;
  let heroCheckedFirst = false;

  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (!a.isHero) {
      if (a.act.startsWith("bets") || a.act.startsWith("raises") || a.act.startsWith("Bet & Muck")) {
        oppBetPending = true;
      }
      continue;
    }
    const act = a.act;
    if (act.startsWith("bets")) { snap.betCount++; snap.betOrRaise = true; oppBetPending = false; }
    else if (act.startsWith("raises") || act.startsWith("Bet & Muck")) { snap.raiseCount++; snap.betOrRaise = true; oppBetPending = false; }
    else if (act.startsWith("calls")) { snap.callCount++; if (oppBetPending) snap.calledBet = true; oppBetPending = false; }
    else if (act.startsWith("checks")) { snap.checkCount++; if (!heroCheckedFirst) heroCheckedFirst = true; }
    else if (act.startsWith("folds")) { if (oppBetPending) snap.foldedToBet = true; oppBetPending = false; }

    if (oppBetPending) snap.facingBet = true;
  }

  // Re-scan: facingBet & raisedBet
  oppBetPending = false;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (!a.isHero) {
      if (a.act.startsWith("bets") || a.act.startsWith("raises") || a.act.startsWith("Bet & Muck")) oppBetPending = true;
      continue;
    }
    if (oppBetPending && (a.act.startsWith("raises") || a.act.startsWith("Bet & Muck"))) snap.raisedBet = true;
    if (oppBetPending) snap.facingBet = true;
    if (a.act.startsWith("calls") || a.act.startsWith("folds")) oppBetPending = false;
  }

  // Check-call / check-raise
  if (heroCheckedFirst) {
    let heroChecked = false;
    let oppBetAfterHeroCheck = false;
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      if (a.isHero && a.act.startsWith("checks")) { heroChecked = true; continue; }
      if (heroChecked && !a.isHero && (a.act.startsWith("bets") || a.act.startsWith("raises") || a.act.startsWith("Bet & Muck"))) {
        oppBetAfterHeroCheck = true;
        snap.checkedThenFacedBet = true;
        continue;
      }
      if (heroChecked && oppBetAfterHeroCheck && a.isHero) {
        if (a.act.startsWith("calls")) snap.didCheckCall = true;
        else if (a.act.startsWith("raises") || a.act.startsWith("Bet & Muck")) snap.didCheckRaise = true;
        heroChecked = false; oppBetAfterHeroCheck = false;
      }
    }
  }

  return snap;
}

function parseSingleHand(raw: string, playerName = "Hero", evOut?: { plans: EvPlan[] }): ParsedHand | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  // Header — support both "Poker Hand #RC123:" and "PokerStars Zoom Hand #456:"
  const idMatch = lines[0].match(/(?:Poker(?:Stars Zoom)?) Hand #(\w+):/);
  // Support ante format: ($0.05/$0.1($0.02)) → groups 1=SB, 2=BB, 3=ante (optional)
  const stakesMatch = lines[0].match(/\(\$([\d.,]+)\/\$([\d.,]+)(?:\(\$([\d.,]+)\))?\)/);
  const dateMatch = lines[0].match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/);
  const tableMatch = (lines[1] || "").match(/Table '([^']+)'/);
  
  if (!idMatch) return null;
  // Skip hands where stakes can't be parsed
  if (!stakesMatch) return null;

  let sb = $(stakesMatch[1]);
  // GG data bug: "$0.25/$0.0" → BB parsed as 0. Fall back to SB×2.
  let bb = $(stakesMatch[2]) || sb * 2;
  // GG 数据 bug 有两个方向，靠「sb:bb 恒为标准配比」的自洽性区分：
  //  (a) 表头错、posts 对（"$0.1/$0.35"，实际 posts $0.1/$0.25）→ 以 posts 为准
  //  (b) posts 行损坏、表头对（实测 NLHPurple12："posts big blind $0.0"、
  //      "posts small blind $0.02"，用底池金额反推证明表头才是对的）→ 以表头为准
  // posts 自洽（或表头不自洽）时采用 posts；否则保留表头。绝不接受 ≤0 的盲注——
  // bb=0 会让所有 BB 除法变成 ±Infinity，一条曲线全毁。
  // 标准配比 = 2:1（NL2/10/50/100/200/1000/2000）或 2.5:1（GG 的 NL5/NL25/NL500，
  // 2400 万手实测主导配置 0.02/0.05、0.1/0.25、2/5）。修复前强制 2:1 会让这三个级别
  // 的表头永远"不自洽"，一旦 posts 写坏（如 NL25 局 posts bb=$0.5）即被盲信成 NL50。
  const sbPostM = raw.match(/posts small blind \$([\d.,]+)/);
  const bbPostM = raw.match(/posts big blind \$([\d.,]+)/);
  const sbPost = sbPostM ? $(sbPostM[1]) : 0;
  const bbPost = bbPostM ? $(bbPostM[1]) : 0;
  const blindPairSane = (s: number, b: number) =>
    s > 0 && b > 0 &&
    (Math.abs(b - s * 2) < 1e-9 || Math.abs(b - s * 2.5) < 1e-9);
  if (blindPairSane(sbPost, bbPost) || !blindPairSane(sb, bb)) {
    if (sbPost > 0) sb = sbPost;
    if (bbPost > 0) bb = bbPost;
  }
  if (!(bb > 0)) bb = sb > 0 ? sb * 2 : 0;
  if (!(sb > 0) && bb > 0) sb = bb / 2;
  if (sb <= 0 || bb <= 0) return null;
  let heroCards = "";
  let flopBoard = "";
  let turnBoard = "";
  let riverBoard = "";
  let flopBoard2 = "";
  let turnBoard2 = "";
  let riverBoard2 = "";
  let flopBoard3 = "";
  let turnBoard3 = "";
  let riverBoard3 = "";
  const heroActions: string[] = [];
  const preflopHeroActions: string[] = [];
  const flopHeroActions: string[] = [];
  const turnHeroActions: string[] = [];
  const riverHeroActions: string[] = [];
  let heroInvested = 0;
  let heroAnte = 0;             // cumulative ante (not covered by raiseTo)
  let priorStreetsInvested = 0; // investment from previous streets

  // Track preflop action order for 3bet detection
  let preflopRaiseCount = 0;
  let heroThreeBet = false;
  let heroFacingRaise = false;
  let heroFacedOpenRaiseAndCalled = false;  // hero 在 BB 面对 open raise（无 limper/squeeze）且 call
  let heroHasRaised = false;  // distinguish 3bet from 4bet
  let heroFirstPreflopActDone = false;  // hero 是否已做第一次翻前自愿行动
  let oppEnteredBeforeHero = false;     // hero 行动前是否有对手自愿进池（call/raise）
  let stealOpp = false;
  let stealAttempt = false;
  let stealPosition: "CO" | "BTN" | "SB" | null = null;

  // ── 翻前加注序列状态机（批次2）──────────────────────────────────
  // pfRaiseSeq 记录翻前每次 raise 的座位号，索引即加注层级：
  //   pfRaiseSeq.length === 0  → 还没人加注（limp pot）
  //   pfRaiseSeq.length === 1  → 只有 open raise（index 0 = openRaiser）
  //   pfRaiseSeq.length === 2  → 出现 3bet（index 1 = 3better）
  //   pfRaiseSeq.length === 3  → 出现 4bet（index 2 = 4better）
  //
  // 场景判定（hero 视角）：
  //   • Open raise    ：hero 是 pfRaiseSeq[0]，前面无人 raise
  //   • Steal         ：hero 在 CO/BTN/SB open raise，且前面所有人都弃牌
  //   • 3bet          ：hero 面对唯一 open raise（facingRaise）后再 raise → pfRaiseSeq[1]
  //   • Squeeze       ：open raise + 至少一个 caller 后，hero 冷加注（squeezeOpp）
  //   • Fold to 3bet  ：hero 是 openRaiser，面对 3bet（heroFacingThreeBet）后弃牌
  //   • 4bet / Fv4bet ：pfRaiseSeq 达到 2 时 hero 再 raise（4bet），或 hero 3bet 后面对 4bet 弃牌
  // ──────────────────────────────────────────────────────────────
  let openRaiserSeat: number | null = null;
  let openRaiserPos = "";
  let lastAggressorSeat: number | null = null;  // last preflop raiser (IP/OOP ref when hero is caller)
  let lastCallerSeat: number | null = null;     // last preflop caller (IP/OOP ref when hero is raiser)
  let callersBeforeNextRaise = 0;   // open raise 后 / 3bet 后 的 caller 数
  let limpersBeforeFirstRaise = 0;  // 首个 raise 之前的 limper（calls）数；0 = 纯净开池防守场景
  let openRaiseToBB: number | null = null;  // 首个 raise 的 raise-to 尺寸（÷bb）；limp 池 = null（BB 防守开注尺寸分桶）
  const pfRaiseSeq: number[] = [];     // 翻前每次 raise 的 seat（[openRaiser, 3better, 4better, ...]）
  let heroIsOpenRaiser = false;
  let heroFacingThreeBet = false;
  let heroFoldedToThreeBet = false;
  let heroIsFourBet = false;
  let heroIsFiveBet = false;
  let heroFacingFourBet = false;
  let heroFoldedToFourBet = false;
  let heroIsSqueeze = false;
  let squeezeOpp = false;           // open raise + at least one caller, hero hasn't entered
  let canFourBet = false;           // hero faces a 3bet (2 raises before hero's action)
  let heroFourBetIP = false;
  let heroFourBetOOP = false;
  let heroThreeBetIP = false;
  let heroThreeBetOOP = false;

  // 翻后行动追踪（批次3）：每条街收集所有行动，街道结束时分析
  type PostAct = { actor: string; isHero: boolean; act: string };
  let curStreetActs: PostAct[] = [];
  let flopSnap: StreetActionSnapshot | null = null;
  let turnSnap: StreetActionSnapshot | null = null;
  let riverSnap: StreetActionSnapshot | null = null;
  let heroCalledThisStreet = false;   // hero called a bet on current postflop street (for next street's Donk)
  let heroCalledPriorStreet = false;  // hero called a bet on the previous postflop street

  type Street = "preflop" | "flop" | "turn" | "river";
  let currentStreet: Street = "preflop";

  // ── All-in EV 追踪 ──────────────────────────────────────────
  let heroIsAllIn = false;
  let heroAllInStreet: Street = "preflop";
  let villainAllInName = "";               // 对手名（跟注 Hero 全押的一方）
  let oppAllInName = "";                   // 最近一个亮出 all-in 动作的对手（无论先后顺序）
  let oppAllInNameBeforeHero = "";         // Hero 全押动作之前最近 all-in 的对手（对手先推、Hero 跟/反推场景）
  // 对手 all-in 动作 → 所在街（"对手全下、Hero 有后手跟注"场景下，全押时点取对手的街）
  const oppAllInStreets = new Map<string, Street>();
  let villainAllInCards: number[] = [];     // 对手亮出的底牌
  // 所有玩家的累计投入（镜像 heroInvested 的 SET/ADD 语义）
  const investedByPlayer = new Map<string, number>();
  // 对手 ante 累计（trackInvestment 的 SET 语义会覆盖盲注前的 ante，单独存放）
  const anteByPlayer = new Map<string, number>();
  // 所有玩家当前街的 "前街投入 baseline"（用于 raises-to 的 SET）
  const priorByPlayer = new Map<string, number>();
  // 收集所有 shows 行：name → cards[]
  const showedCards = new Map<string, number[]>();
  // 弃牌玩家集合（EV 的 live 对手集合判定用）
  const foldedPlayers = new Set<string>();

  // 推算 Hero 位置（解析循环前完成，供 steal 判定使用）
  let heroPosition = "";
  const seatToPos = new Map<number, string>();  // 每个座位 → 位置（供翻前加注序列位置比较）
  let heroSeatNum = 0;
  let allSeatNumbers: number[] = [];
  let buttonSeatNum = 0;
  {
    const tableLine = lines[1] || "";
    const btnMatch = tableLine.match(/Seat #(\d+) is the button/);
    const sizeMatch = tableLine.match(/(\d+)-max/);
    const seatRe = new RegExp(`^Seat (\\d+): ${playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`);
    const heroSeatMatch = lines.find((l) => seatRe.test(l))?.match(/^Seat (\d+):/);
    const allSeatNums = lines
      .map((l) => l.match(/^Seat (\d+):/)?.[1])
      .filter((s): s is string => !!s)
      .map((s) => parseInt(s, 10));
    const seatNumbers = [...new Set(allSeatNums)].sort((a, b) => a - b);
    allSeatNumbers = seatNumbers;
    if (btnMatch && heroSeatMatch && seatNumbers.length >= 2) {
      heroSeatNum = parseInt(heroSeatMatch[1], 10);
      buttonSeatNum = parseInt(btnMatch[1], 10);
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : seatNumbers.length;
      heroPosition = computeHeroPosition(seatNumbers, buttonSeatNum, heroSeatNum, size);
      // 给所有活跃座位算位置
      for (const s of seatNumbers) {
        seatToPos.set(s, computeHeroPosition(seatNumbers, buttonSeatNum, s, size));
      }
    }
  }
  // name → seat 映射（行动行用名字，需查座位以得位置）
  const nameToSeat = new Map<string, number>();
  // 完整玩家名册：从发牌前的座位表行（唯一无歧义锚点 "… ($x in chips)"）取全名，
  // 支持带空格的名字（CoinPoker 昵称可含空格；GG 昵称无空格时行为与旧逻辑逐字节一致）。
  const fullNames = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^Seat (\d+): (\S+) /);
    if (m) nameToSeat.set(m[2], parseInt(m[1], 10));
    const f = l.match(/^Seat (\d+): ([^()]+?) \([^)]*in chips\)/);
    if (f) {
      nameToSeat.set(f[2], parseInt(f[1], 10));
      fullNames.add(f[2]);
    }
  }
  const fullNamesByLen = [...fullNames].sort((a, b) => b.length - a.length);
  const hasSpacedName = fullNamesByLen.some((n) => /\s/.test(n));
  // 带空格名字的行归属：行动行 / SUMMARY 座位行 / 收池行按「已知全名最长前缀」，
  // 退款行按行尾全名精确后缀（endsWith 天然排除 Hero/Hero2 子串冲突）。
  const ownerOfFull = (line: string): string | null => {
    const seatRest = line.match(/^Seat\s+\d+:\s+(.+)$/);
    const rest = seatRest ? seatRest[1] : line;
    for (const n of fullNamesByLen) {
      if (
        rest === n ||
        rest.startsWith(n + " ") ||
        rest.startsWith(n + ":") ||
        rest.startsWith(n + "[") ||
        line.endsWith("returned to " + n)
      ) {
        return n;
      }
    }
    return ownerOfLine(line);
  };
  const belongsToFull = (line: string, player: string): boolean =>
    ownerOfFull(line) === player;

  // 追踪对手投入（镜像 heroInvested 的 SET/ADD 语义）
  function trackInvestment(name: string, action: string) {
    const cur = investedByPlayer.get(name) ?? 0;
    const prior = priorByPlayer.get(name) ?? 0;
    if (action.includes("posts small blind")) {
      investedByPlayer.set(name, sb);
    } else if (action.includes("posts big blind")) {
      investedByPlayer.set(name, bb);
    } else if (action.includes("posts the ante")) {
      // ante 单独累计：对手的 raises/bets 走 SET(prior+to)，ante 混进
      // investedByPlayer 会被后续 SET 覆盖丢失；invOf 处再叠加
      // （无 ante 牌局 anteByPlayer 为空，数值完全不变）。
      const anteMatch = action.match(/posts the ante \$([\d.,]+)/);
      if (anteMatch) anteByPlayer.set(name, (anteByPlayer.get(name) ?? 0) + $(anteMatch[1]));
    } else if (action.includes("raises")) {
      const raiseMatch = action.match(/raises \$([\d.,]+) to \$([\d.,]+)/);
      if (raiseMatch) investedByPlayer.set(name, prior + $(raiseMatch[2]));
      else {
        const anyMatch = action.match(/\$([\d.,]+)/);
        if (anyMatch) investedByPlayer.set(name, cur + $(anyMatch[1]));
      }
    } else if (action.startsWith("bets") || action.startsWith("Bet & Muck")) {
      const bmRaiseMatch = action.match(/Bet & Muck \$[\d.,]+ to \$([\d.,]+)/);
      if (bmRaiseMatch) investedByPlayer.set(name, prior + $(bmRaiseMatch[1]));
      else {
        const betMatch = action.match(/^(?:bets|Bet & Muck) \$([\d.,]+)/);
        if (betMatch) investedByPlayer.set(name, cur + $(betMatch[1]));
      }
    } else if (action.includes("calls")) {
      const callMatch = action.match(/calls \$([\d.,]+)/);
      if (callMatch) investedByPlayer.set(name, cur + $(callMatch[1]));
    }
  }

  // Find Hero's cards and actions
  for (const line of lines) {
    // Track street transitions for multi-street raise calc + capture board cards.
    // Run-it-twice: only capture FIRST/non-prefixed board (representative).
    const isSecondThird = line.startsWith("*** SECOND ") || line.startsWith("*** THIRD ");
    if (!isSecondThird && (
      line.startsWith("*** FLOP") || line.startsWith("*** FIRST FLOP") ||
      line.startsWith("*** TURN") || line.startsWith("*** FIRST TURN") ||
      line.startsWith("*** RIVER") || line.startsWith("*** FIRST RIVER"))) {
      priorStreetsInvested = heroInvested;
      // Reset opponent prior street investment baseline for all tracked players
      for (const [name, invested] of investedByPlayer) {
        priorByPlayer.set(name, invested);
      }
      // Analyze previous street before switching
      const ipFlag = heroIsIP(heroSeatNum, lastAggressorSeat, lastCallerSeat, allSeatNumbers, buttonSeatNum);
      const isAgg = lastAggressorSeat === heroSeatNum;
      if (currentStreet === "flop" && curStreetActs.length > 0) {
        flopSnap = analyzeStreet(curStreetActs, ipFlag, isAgg, true);
      } else if (currentStreet === "turn" && curStreetActs.length > 0) {
        turnSnap = analyzeStreet(curStreetActs, ipFlag, isAgg, heroCalledPriorStreet);
      } else if (currentStreet === "river" && curStreetActs.length > 0) {
        riverSnap = analyzeStreet(curStreetActs, ipFlag, isAgg, heroCalledPriorStreet);
      }
      // Carry hero's call status to next street, then reset for new street
      heroCalledPriorStreet = heroCalledThisStreet;
      heroCalledThisStreet = false;
      curStreetActs = [];  // clear for new street
      if (line.includes("FLOP")) {
        currentStreet = "flop";
        const brackets = line.match(/\[([^\]]+)\]/g) || [];
        flopBoard = brackets.map((b) => b.slice(1, -1)).join(" ");
      } else if (line.includes("TURN")) {
        currentStreet = "turn";
        const brackets = line.match(/\[([^\]]+)\]/g) || [];
        turnBoard = brackets.map((b) => b.slice(1, -1)).join(" ");
      } else if (line.includes("RIVER")) {
        currentStreet = "river";
        const brackets = line.match(/\[([^\]]+)\]/g) || [];
        riverBoard = brackets.map((b) => b.slice(1, -1)).join(" ");
      }
    } else if (isSecondThird && (line.includes("FLOP") || line.includes("TURN") || line.includes("RIVER"))) {
      // 跑两次/三次的后续牌面：不切街、不覆盖主牌面，只并入 board2/board3 字段供展示/EV；
      // THIRD 写 board3（此前直接覆盖 board2 会把第二条牌面顶掉）
      const brackets2 = line.match(/\[([^\]]+)\]/g) || [];
      const joined2 = brackets2.map((b) => b.slice(1, -1)).join(" ");
      const isThird = line.startsWith("*** THIRD ");
      if (line.includes("FLOP")) { if (isThird) flopBoard3 = joined2; else flopBoard2 = joined2; }
      else if (line.includes("TURN")) { if (isThird) turnBoard3 = joined2; else turnBoard2 = joined2; }
      else { if (isThird) riverBoard3 = joined2; else riverBoard2 = joined2; }
    }
    if (line.startsWith(`Dealt to ${playerName}`)) {
      heroCards = line.match(/\[(.+?)\]/)?.[1] || "";
    }
    // 收集所有 shows 行（对手底牌 + Hero 自己的）
    const showsMatch = line.match(/^(.+?): shows \[([^\]]+)\]/);
    if (showsMatch) {
      const cards = showsMatch[2].split(/\s+/).map(parseCard).filter((c) => c >= 0);
      if (cards.length >= 2) showedCards.set(showsMatch[1], cards);
    }
    const actionLine = parseActionLine(line);
    // 收集翻后所有行动（hero + 对手），供 analyzeStreet 用（批次3）
    if (actionLine && currentStreet !== "preflop") {
      const act = actionLine.action.trim().replace(/\0/g, "").replace(/\x08/g, "");
      if (/^(bets|raises|calls|checks|folds|Bet & Muck)/.test(act)) {
        const isHeroAct = actionLine.actor === playerName;
        curStreetActs.push({ actor: actionLine.actor, isHero: isHeroAct, act });
        // Track if hero called a bet this street (for next street's Donk premise)
        if (isHeroAct && /^calls/.test(act)) heroCalledThisStreet = true;
        if (isHeroAct && act.startsWith("folds")) foldedPlayers.add(playerName);
        // Track opponent investment for EV
        if (!isHeroAct) {
          if (act.startsWith("folds")) foldedPlayers.add(actionLine.actor);
          trackInvestment(actionLine.actor, act);
          // 对手 all-in 动作登记（无论先后顺序，供 hero 全押时回溯对手）
          if (act.includes("all-in")) {
            oppAllInName = actionLine.actor;
            oppAllInStreets.set(actionLine.actor, currentStreet);
          }
          // Detect opponent all-in against hero (postflop)
          if (heroIsAllIn && act.includes("all-in") && !villainAllInName) {
            villainAllInName = actionLine.actor;
          }
        }
      }
    }
    if (actionLine?.actor === playerName) {
      let action = actionLine.action.trim();
      // Sanitize: remove null bytes and non-printable garbage from action text
      action = action.replace(/\0/g, "").replace(/\x08/g, "");
      heroActions.push(action);
      if (currentStreet === "preflop") preflopHeroActions.push(action);
      else if (currentStreet === "flop") flopHeroActions.push(action);
      else if (currentStreet === "turn") turnHeroActions.push(action);
      else if (currentStreet === "river") riverHeroActions.push(action);
      if (action.startsWith("folds")) foldedPlayers.add(playerName);

      // ── 检测 Hero 全押 ──
      if (action.includes("all-in") && !heroIsAllIn) {
        heroIsAllIn = true;
        heroAllInStreet = currentStreet;
        // 对手先推、Hero 随后全下（跟注/反推）：回溯最近的对手 all-in 动作
        oppAllInNameBeforeHero = oppAllInName;
      }

      // 3bet opportunity: Hero can act preflop after exactly one opponent raise,
      // before Hero has made a preflop raise.
      const isVoluntary = action.includes("folds") || action.includes("calls") || action.includes("raises") || action.startsWith("bets");
      if (currentStreet === "preflop" && isVoluntary && preflopRaiseCount === 1 && !heroHasRaised) {
        heroFacingRaise = true;
        // IP/OOP at the moment hero faces an open raise (before hero decides to 3bet)
        const ipFlagFacing = heroIsIP(heroSeatNum, openRaiserSeat, lastCallerSeat, allSeatNumbers, buttonSeatNum);
        heroThreeBetIP = ipFlagFacing === true;
        heroThreeBetOOP = ipFlagFacing === false;
      }

      // Steal 判定：只在 hero 第一次翻前自愿行动时评估（决定 steal 机会）
      if (currentStreet === "preflop" && isVoluntary && !heroFirstPreflopActDone) {
        heroFirstPreflopActDone = true;
        const stealPos: "CO" | "BTN" | "SB" | null =
          heroPosition === "CO" ? "CO" :
          heroPosition === "BTN" ? "BTN" :
          heroPosition === "SB" ? "SB" : null;
        if (!oppEnteredBeforeHero && stealPos) {
          stealOpp = true;
          stealPosition = stealPos;
          if (action.includes("raises")) stealAttempt = true;
        }
        // Squeeze opportunity: open raise + at least one caller before hero
        if (pfRaiseSeq.length === 1 && callersBeforeNextRaise > 0) {
          squeezeOpp = true;
        }
        // 4Bet opportunity: hero faces a 3bet (2 raises from others)
        if (pfRaiseSeq.length === 2) {
          canFourBet = true;
          // IP/OOP relative to the 3better (second raiser)
          const threeBetterSeat = pfRaiseSeq[1] > 0 ? pfRaiseSeq[1] : null;
          const ipFlag4bet = heroIsIP(heroSeatNum, threeBetterSeat, lastCallerSeat, allSeatNumbers, buttonSeatNum);
          heroFourBetIP = ipFlag4bet === true;
          heroFourBetOOP = ipFlag4bet === false;
        }
      }

      // Fold to 3bet / Fold to 4bet (hero preflop fold)
      if (currentStreet === "preflop" && action.includes("folds")) {
        if (heroFacingThreeBet) heroFoldedToThreeBet = true;
        if (heroFacingFourBet) heroFoldedToFourBet = true;
      }

      if (action.includes("raises")) {
        // 3bet = first Hero raise after someone else raised, preflop only
        if (currentStreet === "preflop") {
          const raiseIdx = pfRaiseSeq.length;  // hero 这次 raise 是第几次（0=open,1=3bet,2=4bet,...）
          if (raiseIdx === 0) {
            // hero 是 open raiser
            heroIsOpenRaiser = true;
            openRaiserSeat = heroSeatNum;
            openRaiserPos = heroPosition;
          } else if (raiseIdx === 1) {
            // hero 3bet (facing an open raise)
            heroThreeBet = true;
            // IP/OOP already set above when heroFacingRaise was detected
            // Squeeze: hero cold-raises with a caller already in (squeezeOpp set above)
            if (squeezeOpp) {
              heroIsSqueeze = true;
            }
          } else if (raiseIdx === 2) {
            // hero 4bet (facing a 3bet from opponent)
            heroIsFourBet = true;
          } else if (raiseIdx >= 3) {
            // hero 5bet 及以上（profitMatrix 的「跟注 4B」靠它排除再加注的手）
            heroIsFiveBet = true;
          }
          pfRaiseSeq.push(heroSeatNum);
          lastAggressorSeat = heroSeatNum;  // hero 是最后加注者
          // hero 是首个 raise 者（raiseIdx 0 = open/iso，含 limp 池）：记录开注尺寸
          if (raiseIdx === 0 && openRaiseToBB === null) {
            const toM = action.match(/to \$([\d.,]+)/);
            if (toM) openRaiseToBB = $(toM[1]) / bb;
          }
          callersBeforeNextRaise = 0;  // hero raise 后重置 caller 计数
          heroHasRaised = true;
        }
        const raiseMatch = action.match(/raises \$([\d.,]+) to \$([\d.,]+)/);
        if (raiseMatch) {
          const raiseTo = $(raiseMatch[2]);
          if (raiseTo > 0) {
            heroInvested = priorStreetsInvested + raiseTo;
          } else {
            heroInvested += $(raiseMatch[1]);
          }
        } else {
          // Fallback: try old pattern
          const oldMatch = action.match(/raises \$[\d.,]+ to \$([\d.,]+)/);
          if (oldMatch) heroInvested = priorStreetsInvested + $(oldMatch[1]);
          else {
            // Last resort: just extract any dollar amount
            const anyMatch = action.match(/\$([\d.,]+)/);
            if (anyMatch) heroInvested += $(anyMatch[1]);
          }
        }
      }
      else if (action.includes("posts the ante")) {
        const anteMatch = action.match(/posts the ante \$([\d.,]+)/);
        if (anteMatch) heroAnte += $(anteMatch[1]);
      }
      else if (action.includes("posts small blind")) heroInvested += sb;
      else if (action.includes("posts big blind")) heroInvested += bb;
      else if (action.includes("calls")) {
        const callMatch = action.match(/calls \$([\d.,]+)/);
        if (callMatch) heroInvested += $(callMatch[1]);
        if (currentStreet === "preflop") lastCallerSeat = heroSeatNum;
        // BB 面对 open raise 且 call（无 limper、非 squeeze）→ BB 防守 call 信号
        if (currentStreet === "preflop" && heroFacingRaise && limpersBeforeFirstRaise === 0) {
          heroFacedOpenRaiseAndCalled = true;
        }
      }
      else if (action.startsWith("bets") || action.startsWith("Bet & Muck")) {
        // "Bet & Muck" may be a raise: "Bet & Muck $X to $Y" → use "to" amount
        const bmRaiseMatch = action.match(/Bet & Muck \$[\d.,]+ to \$([\d.,]+)/);
        if (bmRaiseMatch) {
          heroInvested = priorStreetsInvested + $(bmRaiseMatch[1]);
        } else {
          const betMatch = action.match(/^(?:bets|Bet & Muck) \$([\d.,]+)/);
          if (betMatch) heroInvested += $(betMatch[1]);
        }
      }
    } else if (currentStreet === "preflop" && actionLine && actionLine.actor !== playerName) {
      const oppAction = actionLine.action.trim();
      const oppSeat = nameToSeat.get(actionLine.actor) ?? 0;
      if (oppAction.startsWith("folds")) foldedPlayers.add(actionLine.actor);
      // Track opponent investment for EV
      trackInvestment(actionLine.actor, oppAction);
      // 对手 all-in 动作登记（无论先后顺序）
      if (oppAction.includes("all-in")) {
        oppAllInName = actionLine.actor;
        oppAllInStreets.set(actionLine.actor, currentStreet);
      }
      // Detect opponent all-in against hero
      if (heroIsAllIn && oppAction.includes("all-in") && !villainAllInName) {
        villainAllInName = actionLine.actor;
      }
      if (oppAction.startsWith("raises")) {
        preflopRaiseCount++;
        pfRaiseSeq.push(oppSeat || -1);
        // 对手是首个 raise 者：记录开注尺寸（"raises $x to $y" / all-in 变体均含 to）
        if (openRaiseToBB === null) {
          const toM = oppAction.match(/to \$([\d.,]+)/);
          if (toM) openRaiseToBB = $(toM[1]) / bb;
        }
        if (oppSeat) lastAggressorSeat = oppSeat;  // 对手是最后加注者
        // hero 是 open raiser 且这是第2次 raise → hero facing 3bet
        if (heroIsOpenRaiser && pfRaiseSeq.length === 2) heroFacingThreeBet = true;
        // hero 是 3bet 者且这是第3次 raise → hero facing 4bet
        if (heroThreeBet && pfRaiseSeq.length === 3) heroFacingFourBet = true;
        // raise 后重置 caller 计数（下一个 raise 前的 call 都算它的 caller）
        callersBeforeNextRaise = 0;
        // 若还没记录 open raiser，这是第一次 raise
        if (openRaiserSeat === null) {
          openRaiserSeat = oppSeat || null;
          openRaiserPos = seatToPos.get(oppSeat) ?? "";
        }
      } else if (oppAction.startsWith("calls")) {
        // Track caller (squeeze + IP/OOP ref when hero is raiser)
        if (pfRaiseSeq.length >= 1) callersBeforeNextRaise++;
        // 首 raise 之前的 limper（用于 BB 防守场景纯净性：limp+iso-raise 排除）
        if (preflopRaiseCount === 0) limpersBeforeFirstRaise++;
        if (oppSeat) lastCallerSeat = oppSeat;
      }
      // hero 行动前：对手自愿进池（call/raise）则无 steal 机会
      if (!heroFirstPreflopActDone && (oppAction.startsWith("calls") || oppAction.startsWith("raises"))) {
        oppEnteredBeforeHero = true;
      }
    }
  }

  // Analyze final street after loop ends (batch 3)
  if (curStreetActs.length > 0) {
    const ipFlag = heroIsIP(heroSeatNum, lastAggressorSeat, lastCallerSeat, allSeatNumbers, buttonSeatNum);
    const isAgg = lastAggressorSeat === heroSeatNum;
    if (currentStreet === "flop" && !flopSnap) flopSnap = analyzeStreet(curStreetActs, ipFlag, isAgg, true);
    else if (currentStreet === "turn" && !turnSnap) turnSnap = analyzeStreet(curStreetActs, ipFlag, isAgg, heroCalledPriorStreet);
    else if (currentStreet === "river" && !riverSnap) riverSnap = analyzeStreet(curStreetActs, ipFlag, isAgg, heroCalledPriorStreet);
  }
  // 没看到某条街的，填空 snapshot
  const ipFallback = heroIsIP(heroSeatNum, lastAggressorSeat, lastCallerSeat, allSeatNumbers, buttonSeatNum);
  const isAggFallback = lastAggressorSeat === heroSeatNum;
  const emptySnap = (): StreetActionSnapshot => ({
    sawStreet: false, isAggressor: isAggFallback, isIP: ipFallback,
    cbetOpp: false, didCbet: false, facingCbet: false, didFoldVsCbet: false, didCallVsCbet: false,
    betOrRaise: false, heroFirstBettor: false, heroCalledPriorStreet: false, facingBet: false, foldedToBet: false, calledBet: false, raisedBet: false,
    checkedThenFacedBet: false, didCheckCall: false, didCheckRaise: false,
    betCount: 0, raiseCount: 0, callCount: 0, checkCount: 0,
  });
  if (!flopSnap) flopSnap = emptySnap();
  if (!turnSnap) turnSnap = emptySnap();
  if (!riverSnap) riverSnap = emptySnap();

  if (!heroCards) return null;

  // Add cumulative ante to final investment
  heroInvested += heroAnte;

  // Handle returned bets (e.g. "Uncalled bet ($9.81) returned to Hero")
  // 必须用 lineBelongsTo 精确匹配玩家名，否则 "returned to Hero2" 会误匹配 "returned to Hero"，
  // 导致 heroInvested 被错扣（同桌有 Hero/Hero2 子串冲突时）。
  for (const line of lines) {
    if (belongsToFull(line, playerName) && line.includes("returned to")) {
      const refundMatch = line.match(/\$([\d.,]+)/);
      if (refundMatch) {
        heroInvested = Math.max(0, heroInvested - $(refundMatch[1]));
      }
    }
    // 对手退回注（带空格名字走全名册后缀匹配，其余沿用旧 \S+ 截取）
    if (hasSpacedName) {
      for (const oppName of fullNamesByLen) {
        if (oppName === playerName || !line.endsWith("returned to " + oppName)) continue;
        const amtMatch = line.match(/Uncalled bet \(\$([\d.,]+)\)/);
        if (amtMatch) {
          const cur = investedByPlayer.get(oppName) ?? 0;
          investedByPlayer.set(oppName, Math.max(0, cur - $(amtMatch[1])));
        }
        break;
      }
    } else {
      const refMatch = line.match(/Uncalled bet \(\$([\d.,]+)\) returned to (\S+)/);
      if (refMatch && refMatch[2] !== playerName) {
        const oppName = refMatch[2];
        const cur = investedByPlayer.get(oppName) ?? 0;
        investedByPlayer.set(oppName, Math.max(0, cur - $(refMatch[1])));
      }
    }
  }

  // Parse pot, rake and jackpot
  // Jackpot 桶 = 彩金/奖池类费用：GG 的 "Jackpot $x" 与 CoinPoker 的
  // "Splash Fee $x"（MEGA SPLASH 随机彩金的固定费用，2026-10-22 guazi 47,376 手
  // 实证 Σ9,940、hero 分摊 1,151——此前完全没解析，水前盈利虚高 22%）
  let rake = 0, jackpot = 0, potTotal = 0;
  for (const line of lines) {
    const potMatch = line.match(/Total pot \$([\d.,]+)/);
    if (potMatch) potTotal += $(potMatch[1]);
    const rakeMatch = line.match(/Rake \$([\d.,]+)/);
    if (rakeMatch) rake += $(rakeMatch[1]);
    const jpMatch = line.match(/Jackpot \$([\d.,]+)/);
    if (jpMatch) jackpot += $(jpMatch[1]);
    const splashMatch = line.match(/Splash Fee \$([\d.,]+)/);
    if (splashMatch) jackpot += $(splashMatch[1]);
  }

  // Parse All-in Insurance (action lines + SUMMARY, deduped by (kind, amount))
  // Hero "Pays All-in Insurance premium ($x)" / "Receives All-in Insurance compensation ($x)"
  // SUMMARY "... AII Premium ($x)" / "... AII Payout ($x)"
  const seenAii = new Set<string>();
  let heroAiiPremium = 0;
  let heroAiiCompensation = 0;
  for (const line of lines) {
    if (!belongsToFull(line, playerName)) {
      // SUMMARY lines are "Seat N: NAME ..."; still must check ownership precisely.
      // (Non-Hero players' AII lines are ignored.)
    }
    // Premium
    for (const m of line.matchAll(/(?:Pays All-in Insurance premium|AII Premium)\s*\(\$([\d.,]+)\)/g)) {
      const amt = $(m[1]);
      const key = "prem:" + amt;
      if (seenAii.has(key)) continue;
      // Only attribute to Hero if the line belongs to Hero.
      if (belongsToFull(line, playerName)) {
        seenAii.add(key);
        heroAiiPremium += amt;
      }
    }
    // Compensation / Payout
    for (const m of line.matchAll(/(?:Receives All-in Insurance compensation|AII Payout)\s*\(\$([\d.,]+)\)/g)) {
      const amt = $(m[1]);
      const key = "comp:" + amt;
      if (seenAii.has(key)) continue;
      if (belongsToFull(line, playerName)) {
        seenAii.add(key);
        heroAiiCompensation += amt;
      }
    }
  }

  // Cash Drop promotion ("Cash Drop to Pot : total $x"). Field only — profit caliber unchanged this round.
  let cashDrop = 0;
  for (const line of lines) {
    const m = line.match(/Cash Drop to Pot\s*:\s*total\s*\$([\d.,]+)/i);
    if (m) cashDrop += $(m[1]);
  }

  // Parse summary to find Hero's result
  const summaryIdx = lines.findIndex((l) => l.startsWith("*** SUMMARY"));
  const showdownIdx = lines.findIndex((l) => l.startsWith("*** SHOWDOWN"));
  const firstShowdownIdx = lines.findIndex((l) => l.startsWith("*** FIRST SHOWDOWN"));

  // --- Unified winning-record collection -------------------------------------
  // We aggregate per-player credited amounts into records, deduplicating so the same
  // amount is never counted twice (P0-1), while preserving legitimate multi-board wins
  // in a single SUMMARY seat line (NEW-2: "won ($71.9) ... and won ($71.9)").
  type WinningRecord = { player: string; amount: number };
  const winningRecords: WinningRecord[] = [];

  if (summaryIdx >= 0) {
    // Primary source: SUMMARY seat lines. Each seat line belongs to exactly one player;
    // sum all won/collected amounts on that line into ONE record (keeps RIT multi-won).
    for (const line of lines.slice(summaryIdx + 1)) {
      if (!/^Seat\s+\d+:/.test(line)) continue;
      const owner = ownerOfFull(line);
      const amt = sumWinningAmounts(line);
      if (amt > 0 && owner) winningRecords.push({ player: owner, amount: amt });
    }
  }

  // Fallback: if SUMMARY gave Hero nothing, scan the SHOWDOWN segment once and dedupe.
  // This is the P0-1 fix — we no longer scan the entire pre-SUMMARY region.
  const heroFromSummary = winningRecords
    .filter((r) => r.player === playerName)
    .reduce((s, r) => s + r.amount, 0);

  const showdownStart = showdownIdx >= 0
    ? showdownIdx
    : (firstShowdownIdx >= 0 ? firstShowdownIdx : -1);
  // SHOWDOWN segment = from first showdown marker to SUMMARY (or end if no summary).
  const showdownEnd = summaryIdx >= 0 ? summaryIdx : lines.length;

  if (heroFromSummary === 0 && showdownStart >= 0) {
    const seenAmt = new Set<number>();
    for (const line of lines.slice(showdownStart + 1, showdownEnd)) {
      if (!belongsToFull(line, playerName)) continue;
      const amt = sumWinningAmounts(line);
      if (amt > 0 && !seenAmt.has(amt)) {
        seenAmt.add(amt);
        winningRecords.push({ player: playerName, amount: amt });
      }
    }
  }

  // CoinPoker 导出缺陷：summary 偶尔漏写部分收池款（边池/第二笔 collected 只出现在
  // 正文 SHOWDOWN 段），summary 给了部分金额就不会触发上面的零回退。正文 collected
  // 合计更大时，整段替换 Hero 的记录以正文为准（GG 两处金额一致，此校验无感）。
  if (heroFromSummary > 0 && showdownStart >= 0) {
    let bodySum = 0;
    for (const line of lines.slice(showdownStart + 1, showdownEnd)) {
      if (!belongsToFull(line, playerName)) continue;
      const m = line.match(/collected\s+\$([\d.,]+)/);
      if (m) bodySum += $(m[1]);
    }
    if (bodySum > heroFromSummary + 0.011) {
      for (let i = winningRecords.length - 1; i >= 0; i--) {
        if (winningRecords[i].player === playerName) winningRecords.splice(i, 1);
      }
      winningRecords.push({ player: playerName, amount: bodySum });
    }
  }

  // If still no SUMMARY at all (truncated hand) and no SHOWDOWN fallback captured anything,
  // we conservatively leave winningRecords as-is rather than scanning the whole hand (P1-8).

  const heroWon = winningRecords
    .filter((r) => r.player === playerName)
    .reduce((s, r) => s + r.amount, 0);
  const totalWonByAllPlayers = winningRecords.reduce((s, r) => s + r.amount, 0);

  // Saw flop = a flop was actually dealt AND Hero didn't fold before it
  // (必须在 showdown 判定之前，因为 WTSD 要求 sawFlop)
  const hasFlop = lines.some((l) => l.startsWith("*** FLOP") || l.startsWith("*** FIRST FLOP") || l.startsWith("*** SECOND FLOP") || l.startsWith("*** THIRD FLOP"));
  let sawFlop = false;
  if (hasFlop && summaryIdx >= 0) {
    const heroSummary = lines.slice(summaryIdx).find((l) => belongsToFull(l, playerName));
    if (heroSummary && !heroSummary.includes("folded before Flop")) {
      sawFlop = true;
    }
  }

  // Hero went to showdown = Hero didn't fold before showdown AND cards were shown AND saw flop
  // 且至少一名对手也没弃牌（摊牌的定义，H2N 口径：手末 >1 人未弃牌）。CoinPoker 导出
  // 在对手全弃、Hero 无对抗独赢时也写 "Hero showed [...] and won"（guazi 47,376 手实证
  // 3,049 手全中），不校验对手会把这批手从红线误挪进蓝线。
  // 翻前独赢亮牌如 RC4395287811 不算 WTSD——没看到翻牌。
  const anyShowCards = lines.some((l) => l.includes("shows [") || l.includes("showed ["));
  let showdown = false;
  if (anyShowCards && summaryIdx >= 0) {
    let notFoldedOpps = false;
    for (const name of nameToSeat.keys()) {
      if (name !== playerName && !foldedPlayers.has(name)) { notFoldedOpps = true; break; }
    }
    const heroSummary = lines.slice(summaryIdx).find((l) => belongsToFull(l, playerName));
    if (notFoldedOpps && heroSummary && !heroSummary.includes("folded") && sawFlop) {
      showdown = true;
    }
  }

  const heroWinShare = totalWonByAllPlayers > 0 && heroWon > 0 ? heroWon / totalWonByAllPlayers : 0;
  const heroRake = rake * heroWinShare;
  const heroJackpot = jackpot * heroWinShare;

  // Game profit (pre-rake): heroWon is post-rake, add back Hero's rake/JP share.
  const gameUSD = heroWon > 0 ? heroWon + heroRake + heroJackpot - heroInvested : heroWon - heroInvested;
  const gameBB = Math.round((gameUSD / bb) * 100) / 100;

  // ── Compute All-in EV ──────────────────────────────────────
  // 跑两次/三次时 SUMMARY 兜底：SECOND/THIRD Board 行补齐后续牌面。
  // GG 在转牌/河牌才跑时这些行是缩写（只写新发的牌），
  // 需要拼上与第一条共享的翻牌/翻牌+转牌前缀。
  const fillRitBoard = (segRaw: string, into: "b2" | "b3") => {
    const seg = segRaw.split(/\s+/).filter(Boolean);
    if (!seg.length) return;
    const prefix = seg.length >= 5 ? [] :
      riverBoard.split(/\s+/).filter(Boolean).slice(0, 5 - seg.length);
    const full = [...prefix, ...seg].join(" ");
    if (into === "b2") riverBoard2 = full; else riverBoard3 = full;
  };
  if (!riverBoard2) {
    const m = raw.match(/^SECOND Board \[([^\]]+)\]/m);
    if (m) fillRitBoard(m[1], "b2");
  }
  if (!riverBoard3) {
    const m = raw.match(/^THIRD Board \[([^\]]+)\]/m);
    if (m) fillRitBoard(m[1], "b3");
  }
  // ── 全下对手归属（EV 的前置条件）──
  // 场景优先级：
  //   1. Hero 先全押、对手 all-in 跟注（主循环内已登记 villainAllInName）
  //   2. 对手先 all-in、Hero 随后全押（跟注/反推）→ 回溯 oppAllInNameBeforeHero
  //   3. 对手跟注把 Hero 推到全下但 GG 未写 all-in 后缀（"calls $X"）→
  //      摊牌时唯一亮牌的非 Hero 玩家即主要对手
  //   4. 对手全下、Hero 有后手跟注并打到摊牌（GG 同样不给 Hero 写 all-in 后缀）：
  //      Hero 的钱已全额进入对抗全下对手，风险与自身全押相同，EV 必须调整。
  // 成立条件（HM3/PT4 口径）：河牌前已无下注空间 —— Hero 全下，或所有未弃牌
  // 对手都已 all-in；且未弃牌对手的底牌可读，否则维持 allInEV=null。
  // Hero 全下但无人跟注（全弃收池）不调整。
  const streetRank: Record<Street, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
  const liveOpps: string[] = [];
  for (const name of nameToSeat.keys()) {
    if (name !== playerName && !foldedPlayers.has(name)) liveOpps.push(name);
  }
  const oppsReadable =
    liveOpps.length > 0 && liveOpps.every((n) => (showedCards.get(n)?.length ?? 0) >= 2);
  const allLiveOppsAllIn =
    liveOpps.length > 0 && liveOpps.every((n) => oppAllInStreets.has(n));

  let allInStreet: Street = heroAllInStreet;
  if (heroIsAllIn && !villainAllInName) {
    villainAllInName = oppAllInNameBeforeHero;
  }
  if (heroIsAllIn && !villainAllInName) {
    // 场景 3：Hero 推、对手有后手跟注（GG 不给双方写 all-in 后缀）。
    // 注意 showedCards 含 Hero 自己且可能混入已弃牌玩家的 muck reveal，
    // 因此判定对象是「未弃牌且底牌可读的非 Hero 玩家」，恰好 1 人即主要对手。
    const candidates = liveOpps.filter(
      (n) => !foldedPlayers.has(n) && (showedCards.get(n)?.length ?? 0) >= 2,
    );
    if (candidates.length === 1) villainAllInName = candidates[0];
  }
  if (!heroIsAllIn && !villainAllInName && allLiveOppsAllIn && oppsReadable && showedCards.has(playerName)) {
    villainAllInName = liveOpps[0];
  }
  // 全押时点：Hero 全下取 Hero 的街；否则取未弃牌对手中最后一次 all-in 的街
  // （此后所有人投入封顶、再无下注空间）。
  if (!heroIsAllIn) {
    for (const n of liveOpps) {
      const s = oppAllInStreets.get(n);
      if (s && streetRank[s] > streetRank[allInStreet]) allInStreet = s;
    }
  }
  let allInEV: number | null = null;
  if (villainAllInName) {
    // Get villain's showed cards
    const vCards = showedCards.get(villainAllInName);
    if (vCards && vCards.length >= 2) {
      villainAllInCards = vCards;
      // Determine board at all-in moment
      const boardAtAllIn: number[] = [];
      if (allInStreet === "flop" || allInStreet === "turn" || allInStreet === "river") {
        const flopCards = flopBoard ? flopBoard.split(/\s+/).map(parseCard).filter((c) => c >= 0) : [];
        boardAtAllIn.push(...flopCards);
      }
      if (allInStreet === "turn" || allInStreet === "river") {
        // turnBoard includes flop + turn; extract just the turn card
        const turnOnly = turnBoard ? turnBoard.split(/\s+/).map(parseCard).filter((c) => c >= 0) : [];
        if (turnOnly.length > flopBoard.split(/\s+/).filter(Boolean).length) {
          const flopLen = flopBoard ? flopBoard.split(/\s+/).filter(Boolean).length : 0;
          boardAtAllIn.length = 0; // reset: flop + turn
          boardAtAllIn.push(...turnOnly.slice(0, flopLen + 1));
        } else {
          boardAtAllIn.push(...turnOnly);
        }
      }
      if (allInStreet === "river") {
        const riverCards = riverBoard ? riverBoard.split(/\s+/).map(parseCard).filter((c) => c >= 0) : [];
        boardAtAllIn.length = 0;
        boardAtAllIn.push(...riverCards);
      }

      // Parse hero hole cards
      const heroHole = heroCards.split(/\s+/).map(parseCard).filter((c) => c >= 0);

      // 分层参与者 = Hero + 底牌可读的未弃牌对手（死钱单独经 deadInv 计入整池）
      const participants: string[] = [playerName];
      for (const n of liveOpps) {
        if ((showedCards.get(n)?.length ?? 0) >= 2) participants.push(n);
      }
      if (heroHole.length === 2 && boardAtAllIn.length <= 5 && participants.length >= 2) {
        try {
          // 跑两次=两条独立发牌、跑三次=三条，EV 取各条牌面 equity 的平均；
          // 第二/三条牌面截到与第一条相同的已知深度（全押时点的公共牌数）
          const boardsForEV: number[][] = [boardAtAllIn];
          if (riverBoard2) {
            const b2 = riverBoard2.split(/\s+/).map(parseCard).filter((c) => c >= 0);
            boardsForEV.push(b2.slice(0, boardAtAllIn.length));
          }
          if (riverBoard3) {
            const b3 = riverBoard3.split(/\s+/).map(parseCard).filter((c) => c >= 0);
            boardsForEV.push(b3.slice(0, boardAtAllIn.length));
          }
          // 分层投入：Hero 取 heroInvested（已含 ante）；对手 = investedByPlayer + ante
          // （ante 单独存放，见 trackInvestment）
          const invOf = (n: string) =>
            n === playerName ? heroInvested : (investedByPlayer.get(n) ?? 0) + (anteByPlayer.get(n) ?? 0);
          // 死钱：弃牌玩家的投入也躺在池里。GG 的全下 EV 按含死钱的整池计
          // （equity × 全池 − 自身投入），每层要加上非参与者在该层区间的投入；
          // uncalled 已退款的部分不在 investedByPlayer 里，不会重复计。
          const participantSet = new Set(participants);
          const deadInv: number[] = [];
          for (const [n, v] of investedByPlayer) {
            if (!participantSet.has(n)) deadInv.push(v + (anteByPlayer.get(n) ?? 0));
          }
          for (const [n, v] of anteByPlayer) {
            if (!participantSet.has(n) && !investedByPlayer.has(n)) deadInv.push(v);
          }
          const plan: EvPlan = {
            handId: idMatch[1],
            heroHole,
            bb,
            heroInvested,
            boards: boardsForEV,
            oppHoles: participants.slice(1).map((n) => showedCards.get(n)!),
            partInv: participants.map(invOf),
            deadInv,
          };
          if (evOut) {
            // 两阶段：EV 留待 Worker 后台逐 plan 求解，解析热路径零枚举成本
            evOut.plans.push(plan);
          } else {
            const solved = solveEvPlan(plan);
            allInEV = solved;
          }
        } catch {
          // equity computation failed → fall back to actual result
          allInEV = null;
        }
      }
    }
  }

  return {
    id: idMatch[1],
    date: dateMatch?.[1] || "",
    table: tableMatch?.[1] || "",
    stakes: stakesMatch ? `${sb}/${bb}` : "",
    heroPosition,
    heroCards,
    heroChipsStart: 0,
    heroChipsEnd: 0,
    actions: heroActions,
    preflopActions: preflopHeroActions,
    flopActions: flopHeroActions,
    turnActions: turnHeroActions,
    riverActions: riverHeroActions,
    result: gameBB,
    gameUSDRaw: gameUSD,
    investedBB: Math.round((heroInvested / bb) * 100) / 100,
    showdown,
    sawFlop,
    threeBet: heroThreeBet,
    facingRaise: heroFacingRaise,
    stealAttempt,
    stealPosition,
    stealOpp,
    isOpenRaiser: heroIsOpenRaiser,
    isRFI: heroIsOpenRaiser && !oppEnteredBeforeHero,
    rfiOpportunity: !oppEnteredBeforeHero,
    openRaiserPos,
    limpersBeforeFirstRaise,
    openRaiseToBB,
    facedOpenRaiseAndCalled: heroFacedOpenRaiseAndCalled,
    facingThreeBet: heroFacingThreeBet,
    foldedToThreeBet: heroFoldedToThreeBet,
    isFourBet: heroIsFourBet,
    isFiveBet: heroIsFiveBet,
    facingFourBet: heroFacingFourBet,
    foldedToFourBet: heroFoldedToFourBet,
    isSqueeze: heroIsSqueeze,
    squeezeOpp,
    canFourBet,
    fourBetIP: heroFourBetIP,
    fourBetOOP: heroFourBetOOP,
    threeBetVsRaiserIP: heroThreeBetIP,
    threeBetVsRaiserOOP: heroThreeBetOOP,
    flopStreet: flopSnap,
    turnStreet: turnSnap,
    riverStreet: riverSnap,
    rake,
    jackpot,
    potTotal,
    heroRake,
    heroJackpot,
    heroWon,
    heroAiiPremium,
    heroAiiCompensation,
    cashDrop,
    flopBoard,
    turnBoard,
    riverBoard,
    flopBoard2,
    turnBoard2,
    riverBoard2,
    flopBoard3,
    turnBoard3,
    riverBoard3,
    allInEV,
    numSeats: allSeatNumbers.length,
    // parseGGHandHistory 在去重后按 rawById 回填（见该函数尾部）；
    // parseSingleHand 自身拿不到去重后的原文，先给空串兜底
    raw: "",
    summary: lines.slice(summaryIdx >= 0 ? summaryIdx : lines.length).join(" "),
  };
}

