/* ================================================================
   hhStats —— 统计引擎（客户端本地执行）
   HM3/PT4 口径统计与运气统计；只消费 ParsedHand 数据，不依赖解析器。
   ================================================================ */

import { parseCard, evaluate, compareRanks } from "./poker";
import type { ParsedHand, SessionStats, StreetAggStats } from "./hhTypes";

export function computeStats(hands: ParsedHand[]): SessionStats {
  let totalProfitBBRaw = 0;   // unrounded game-profit BB (P2-1 / NEW-1)
  let handsWon = 0, handsLost = 0;
  let biggestWin = -Infinity, biggestLoss = Infinity;
  let wonShowdown = 0, lostShowdown = 0, wonWithoutShowdown = 0;
  let raises = 0;
  let handsPlayedVPIP = 0;
  const profitHistory: { hand: number; profit: number }[] = [];
  const netProfitHistory: { hand: number; profit: number }[] = [];
  const sdHistory: { hand: number; profit: number }[] = [];
  const nsdHistory: { hand: number; profit: number }[] = [];
  const evHistory: { hand: number; profit: number }[] = [];
  let cum = 0, cumNet = 0, cumSD = 0, cumNSD = 0;
  let cumEV = 0;
  let totalRake = 0, totalHeroRake = 0, totalHeroJackpot = 0;
  let totalJackpot = 0;
  let gameProfit = 0;  // game profit before rake/jp
  let netProfit = 0;   // net profit after rake/jp
  let netProfitBB = 0, totalHeroRakeBB = 0, totalHeroJackpotBB = 0;
  let sawFlopCount = 0, wtsdCount = 0, wwsfCount = 0, wsdWins = 0, wsdTotal = 0;
  let threeBetCount = 0, facingRaiseCount = 0;
  let stealOppTotal = 0, stealAttTotal = 0;
  let stealOppCO = 0, stealAttCO = 0;
  let stealOppBTN = 0, stealAttBTN = 0;
  let stealOppSB = 0, stealAttSB = 0;
  // 翻前细分计数（批次2）
  let threeBetIPCount = 0, threeBetIPopp = 0;
  let threeBetOOPCount = 0, threeBetOOPopp = 0;
  let fourBetCount = 0, fourBetOppCount = 0;
  let fourBetIPcount = 0, fourBetIPopp = 0, fourBetOOPcount = 0, fourBetOOPopp = 0;
  let squeezeCount = 0, squeezeOppCount = 0;
  let foldToThreeBetCount = 0, facingThreeBetCount = 0;
  let foldToFourBetCount = 0, facingFourBetCount = 0;

  for (const h of hands) {
    totalRake += h.rake;
    totalHeroRake += h.heroRake;
    totalHeroJackpot += h.heroJackpot;
    totalJackpot += h.jackpot;

    const stake = parseFloat(h.stakes.split("/")[1]);
    // Precision (P2-1 / NEW-1): use the unrounded USD authority; only round at output.
    const gameUSD = h.gameUSDRaw;
    const gameBB = gameUSD / stake;
    // Net (post-rake) USD. AII premium is a post-rake cost; AII compensation is post-rake income.
    const netUSD = gameUSD - h.heroRake - h.heroJackpot - h.heroAiiPremium + h.heroAiiCompensation;
    gameProfit += gameUSD;
    netProfit += netUSD;
    netProfitBB += netUSD / stake;
    totalHeroRakeBB += h.heroRake / stake;
    totalHeroJackpotBB += h.heroJackpot / stake;

    if (h.facingRaise) facingRaiseCount++;
    if (h.threeBet) threeBetCount++;

    // Steal 机会/尝试计数
    if (h.stealOpp) {
      stealOppTotal++;
      if (h.stealAttempt) stealAttTotal++;
      if (h.stealPosition === "CO") { stealOppCO++; if (h.stealAttempt) stealAttCO++; }
      else if (h.stealPosition === "BTN") { stealOppBTN++; if (h.stealAttempt) stealAttBTN++; }
      else if (h.stealPosition === "SB") { stealOppSB++; if (h.stealAttempt) stealAttSB++; }
    }

    // 3Bet IP/OOP: relative to open raiser (computed at parse time via heroIsIP)
    // When IP/OOP can't be determined (null), don't count toward either denominator
    if (h.facingRaise && (h.threeBetVsRaiserIP || h.threeBetVsRaiserOOP)) {
      if (h.threeBetVsRaiserIP) { threeBetIPopp++; if (h.threeBet) threeBetIPCount++; }
      else { threeBetOOPopp++; if (h.threeBet) threeBetOOPCount++; }
    }
    // 4Bet: hero faces a 3bet (canFourBet) and raises
    if (h.canFourBet) {
      fourBetOppCount++; if (h.isFourBet) fourBetCount++;
      if (h.fourBetIP) { fourBetIPopp++; if (h.isFourBet) fourBetIPcount++; }
      else if (h.fourBetOOP) { fourBetOOPopp++; if (h.isFourBet) fourBetOOPcount++; }
    }
    // Squeeze: hero had squeeze opportunity and squeezed
    if (h.squeezeOpp) { squeezeOppCount++; if (h.isSqueeze) squeezeCount++; }
    // Fold to 3Bet：hero 是 open raiser，面对 3bet
    if (h.facingThreeBet) { facingThreeBetCount++; if (h.foldedToThreeBet) foldToThreeBetCount++; }
    // Fold to 4Bet：hero 是 3bet 者，面对 4bet
    if (h.facingFourBet) { facingFourBetCount++; if (h.foldedToFourBet) foldToFourBetCount++; }

    // WWSF / W$SD (P1-2): judge "won" by whether Hero was credited a pot (heroWon>0),
    // not by whole-hand pre-rake profit — correct under side/split/rake scenarios.
    if (h.sawFlop) {
      sawFlopCount++;
      if (h.heroWon > 0) wwsfCount++;
    }
    if (h.showdown) {
      wtsdCount++;
      wsdTotal++;
      if (h.heroWon > 0) wsdWins++;
    }
    cum += gameBB;
    totalProfitBBRaw += gameBB;

    // SD/NSD curves (P1-1): net (post-rake) BB caliber, aligned with the purple net line.
    const netBB = netUSD / stake;
    if (h.showdown) {
      cumSD += netBB;
    } else {
      cumNSD += netBB;
    }
    cumNet += netBB;

    if (h.heroWon > 0) {
      handsWon++;
      if (h.showdown) wonShowdown++;
      else wonWithoutShowdown++;
    } else if (h.result < 0) {
      handsLost++;
      if (h.showdown) lostShowdown++;
    }

    biggestWin = Math.max(biggestWin, h.result);
    biggestLoss = Math.min(biggestLoss, h.result);

    // VPIP/PFR are strictly preflop stats; postflop actions stay in `actions`.
    const hasVPIP = h.preflopActions.some((a) =>
      (a.includes("calls") || a.includes("raises")) && !a.includes("posts")
    );
    if (hasVPIP) handsPlayedVPIP++;

    // PFR: preflop raises only
    const hasPFR = h.preflopActions.some((a) => a.includes("raises"));
    if (hasPFR) raises++;

    const handNum = profitHistory.length + 1;
    profitHistory.push({ hand: handNum, profit: cum });
    netProfitHistory.push({ hand: handNum, profit: cumNet });
    sdHistory.push({ hand: handNum, profit: cumSD });
    nsdHistory.push({ hand: handNum, profit: cumNSD });
    // EV: use allInEV if available, otherwise actual pre-rake profit
    const evBB = h.allInEV !== null ? h.allInEV : gameBB;
    cumEV += evBB;
    evHistory.push({ hand: handNum, profit: cumEV });
  }

  const totalHands = hands.length;
  const estHandsPerHour = 100;

  // Calculate average stakes
  const stakesCount = new Map<string, number>();
  for (const h of hands) {
    stakesCount.set(h.stakes, (stakesCount.get(h.stakes) || 0) + 1);
  }
  const dominantStakes = [...stakesCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  // Postflop street aggregation (batch 3)
  // CBet/FvCB depend on preflop aggressor role; Donk/CheckC/CheckR/AFq are action-based.
  const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
  const aggStreet = (key: "flopStreet" | "turnStreet" | "riverStreet"): StreetAggStats => {
    let cbetOpp = 0, cbetDid = 0;
    let cbetIPopp = 0, cbetIPdid = 0, cbetOOPopp = 0, cbetOOPdid = 0;
    let fvcOpp = 0, fvcDid = 0, fvcIPopp = 0, fvcIPdid = 0, fvcOOPopp = 0, fvcOOPdid = 0;
    let donkOpp = 0, donkDid = 0;
    let ccOpp = 0, ccDid = 0, crOpp = 0, crDid = 0;
    let totBet = 0, totRaise = 0, totCall = 0, totCheck = 0;
    for (const h of hands) {
      const s = h[key];
      if (!s.sawStreet) continue;
      // CBet: hero is preflop raiser
      if (s.cbetOpp) {
        cbetOpp++; if (s.didCbet) cbetDid++;
        if (s.isIP === true) { cbetIPopp++; if (s.didCbet) cbetIPdid++; }
        else if (s.isIP === false) { cbetOOPopp++; if (s.didCbet) cbetOOPdid++; }
      }
      // FvCB: hero faces a c-bet from the raiser
      if (s.facingCbet) {
        fvcOpp++; if (s.didFoldVsCbet) fvcDid++;
        if (s.isIP === true) { fvcIPopp++; if (s.didFoldVsCbet) fvcIPdid++; }
        else if (s.isIP === false) { fvcOOPopp++; if (s.didFoldVsCbet) fvcOOPdid++; }
      }
      // Donk: hero is NOT preflop raiser, OOP, first to bet
      //   flop: no prior-street condition
      //   turn/river: hero called a bet on the prior street (passive caller now leads out)
      if (!s.isAggressor && s.isIP === false && !s.facingCbet && s.heroCalledPriorStreet) {
        donkOpp++; if (s.heroFirstBettor) donkDid++;
      }
      // Check-call / check-raise
      if (s.checkedThenFacedBet) { ccOpp++; crOpp++; if (s.didCheckCall) ccDid++; if (s.didCheckRaise) crDid++; }
      // AFq
      totBet += s.betCount; totRaise += s.raiseCount; totCall += s.callCount; totCheck += s.checkCount;
    }
    const afqDenom = totBet + totRaise + totCall + totCheck;
    return {
      cbet: pct(cbetDid, cbetOpp),
      cbetIP: pct(cbetIPdid, cbetIPopp),
      cbetOOP: pct(cbetOOPdid, cbetOOPopp),
      fvc: pct(fvcDid, fvcOpp),
      fvcIP: pct(fvcIPdid, fvcIPopp),
      fvcOOP: pct(fvcOOPdid, fvcOOPopp),
      donk: pct(donkDid, donkOpp),
      checkC: pct(ccDid, ccOpp),
      checkR: pct(crDid, crOpp),
      afq: pct(totBet + totRaise, afqDenom),
    };
  };

  return {
    totalHands,
    handsPlayed: handsPlayedVPIP,
    handsWon,
    handsLost,
    totalProfitBB: Math.round(totalProfitBBRaw * 100) / 100,
    netProfitBB: Math.round(netProfitBB * 100) / 100,
    totalProfitCurrency: Math.round(netProfit * 100) / 100,
    gameProfitCurrency: Math.round(gameProfit * 100) / 100,
    totalHeroRakeBB: Math.round(totalHeroRakeBB * 100) / 100,
    totalHeroJackpotBB: Math.round(totalHeroJackpotBB * 100) / 100,
    bbPer100: totalHands > 0 ? Math.round((netProfitBB / totalHands) * 10000) / 100 : 0,
    vpip: totalHands > 0 ? Math.round((handsPlayedVPIP / totalHands) * 100) : 0,
    pfr: totalHands > 0 ? Math.round((raises / totalHands) * 100) : 0,
    threeBet: facingRaiseCount > 0 ? Math.round((threeBetCount / facingRaiseCount) * 1000) / 10 : 0,
    stealTotal: stealOppTotal > 0 ? Math.round((stealAttTotal / stealOppTotal) * 1000) / 10 : 0,
    stealCO: stealOppCO > 0 ? Math.round((stealAttCO / stealOppCO) * 1000) / 10 : 0,
    stealBTN: stealOppBTN > 0 ? Math.round((stealAttBTN / stealOppBTN) * 1000) / 10 : 0,
    stealSB: stealOppSB > 0 ? Math.round((stealAttSB / stealOppSB) * 1000) / 10 : 0,
    threeBetIP: threeBetIPopp > 0 ? Math.round((threeBetIPCount / threeBetIPopp) * 1000) / 10 : 0,
    threeBetOOP: threeBetOOPopp > 0 ? Math.round((threeBetOOPCount / threeBetOOPopp) * 1000) / 10 : 0,
    fourBet: fourBetOppCount > 0 ? Math.round((fourBetCount / fourBetOppCount) * 1000) / 10 : 0,
    fourBetIP: fourBetIPopp > 0 ? Math.round((fourBetIPcount / fourBetIPopp) * 1000) / 10 : 0,
    fourBetOOP: fourBetOOPopp > 0 ? Math.round((fourBetOOPcount / fourBetOOPopp) * 1000) / 10 : 0,
    squeeze: squeezeOppCount > 0 ? Math.round((squeezeCount / squeezeOppCount) * 1000) / 10 : 0,
    foldToThreeBet: facingThreeBetCount > 0 ? Math.round((foldToThreeBetCount / facingThreeBetCount) * 1000) / 10 : 0,
    foldToFourBet: facingFourBetCount > 0 ? Math.round((foldToFourBetCount / facingFourBetCount) * 1000) / 10 : 0,
    flop: aggStreet("flopStreet"),
    turn: aggStreet("turnStreet"),
    river: aggStreet("riverStreet"),
    wonShowdown,
    lostShowdown,
    wonWithoutShowdown,
    biggestWin,
    biggestLoss,
    profitHistory,
    netProfitHistory,
    sdHistory,
    nsdHistory,
    evHistory,
    hourlyRate: totalHands > 0 ? Math.round((totalProfitBBRaw / (totalHands / estHandsPerHour)) * 100) / 100 : 0,
    totalHours: Math.round((totalHands / estHandsPerHour) * 10) / 10,
    totalRake: Math.round(totalRake * 100) / 100,
    totalHeroRake: Math.round(totalHeroRake * 100) / 100,
    totalJackpot: Math.round(totalJackpot * 100) / 100,
    totalHeroJackpot: Math.round(totalHeroJackpot * 100) / 100,
    avgStakes: dominantStakes,
    wtsd: sawFlopCount > 0 ? Math.round((wtsdCount / sawFlopCount) * 1000) / 10 : 0,
    wwsf: sawFlopCount > 0 ? Math.round((wwsfCount / sawFlopCount) * 1000) / 10 : 0,
    wsd: wsdTotal > 0 ? Math.round((wsdWins / wsdTotal) * 1000) / 10 : 0,
  };
}

/* ================================================================
   运气统计（luck stats）
   ================================================================ */

// 起手牌归类：返回标准化标签，或 null（不是目标大牌）
// AK 同时匹配 AKs 和 AKo（同花/非同花合并统计）
// heroCards 格式为 "Qc 4s"（两张牌之间有空格）
const RANK_ORDER = "23456789TJQKA";
function classifyPremium(cards: string): string | null {
  const m = cards.match(/^([2-9TJQKA])([shdc])\s+([2-9TJQKA])([shdc])$/);
  if (!m) return null;
  const [_, r1, s1, r2, s2] = m;
  const suited = s1 === s2;
  if (r1 === r2) {
    if (r1 === "A") return "AA";
    if (r1 === "K") return "KK";
    if (r1 === "Q") return "QQ";
    if (r1 === "J") return "JJ";
    return null;
  }
  // 用 RANK_ORDER 索引比较点数，避免字符串字典序错误（'A' < 'K'）
  const i1 = RANK_ORDER.indexOf(r1);
  const i2 = RANK_ORDER.indexOf(r2);
  const hi = Math.max(i1, i2);
  const lo = Math.min(i1, i2);
  // hi=A(12), lo=K(11) → AK
  if (hi === 12 && lo === 11) {
    return suited ? "AKs" : "AKo";
  }
  return null;
}

// 理论到手频率（百分比）：1326 种组合中该牌的数量占比
// AA/KK/QQ/JJ 各 6/1326 = 0.4525%，AKs 4/1326 = 0.3017%，AKo 12/1326 = 0.9022%
const THEORY_FREQ: Record<string, number> = {
  AA: 0.4525, KK: 0.4525, QQ: 0.4525, JJ: 0.4525,
  AKs: 0.3017, AKo: 0.9022,
};

export interface PremiumFreqStat {
  label: string;        // "AA" / "AKs" / "AKo"
  count: number;        // 实际到手次数
  theoryCount: number;  // 理论到手次数 = totalHands × theoryPct
  wsdPct: number;       // 该起手牌的 W$SD（摊牌胜率 %）
  // 数据库平均赢率列留空，以后填
}

export interface StreetTwoPairStat {
  street: "flop" | "turn" | "river";
  reachedCount: number;  // 这条街新击中/增强到两对+的总手数（摊牌手）
  deadCount: number;     // 其中最终摊牌输的手数
}

export interface LuckStats {
  totalHands: number;
  premiumFreq: PremiumFreqStat[];
  streetTwoPair: StreetTwoPairStat[];
}

// 把 board 字符串解析成 card number 数组
function boardToCards(board: string): number[] {
  const cards: number[] = [];
  for (const tok of board.split(/\s+/)) {
    if (tok.length === 2) {
      const c = parseCard(tok);
      if (c >= 0) cards.push(c);
    }
  }
  return cards;
}

// 评估任意张数牌的牌力 category（0=高牌 ... 8=同花顺）
// 用于底牌阶段（2 张）等 evaluate() 无法处理的情况
function evalCategory(cards: number[]): number[] {
  if (cards.length >= 5) return evaluate(cards);
  if (cards.length === 0) return [0];
  // <5 张：直接用 evaluate5 的计数逻辑提取 category
  const ranks = cards.map((c) => c % 13).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (entries[0][1] === 4) return [7, entries[0][0]];
  if (entries[0][1] === 3 && entries[1]?.[1] === 2) return [6, entries[0][0], entries[1][0]];
  if (entries[0][1] === 3) return [3, entries[0][0]];
  if (entries[0][1] === 2 && entries[1]?.[1] === 2) return [2, entries[0][0], entries[1][0]];
  if (entries[0][1] === 2) return [1, entries[0][0]];
  return [0, ...ranks];
}

export function computeLuckStats(hands: ParsedHand[]): LuckStats {
  const totalHands = hands.length;

  // 指标 1+2：起手牌频率 + W$SD
  const groups: Record<string, { count: number; sdWon: number; sdLost: number }> = {};
  for (const h of hands) {
    if (!h.heroCards) continue;
    const cls = classifyPremium(h.heroCards);
    if (!cls) continue;
    if (!groups[cls]) groups[cls] = { count: 0, sdWon: 0, sdLost: 0 };
    groups[cls].count++;
    // W$SD 口径与 computeStats 一致：用 heroWon（是否赢 pot）而非 result（净盈亏 BB）。
    // 否则 side pot / 平池 + 重抽水场景下，两个 tab 的 W$SD 会打架。
    if (h.showdown && h.heroWon > 0) groups[cls].sdWon++;
    else if (h.showdown && h.heroWon === 0) groups[cls].sdLost++;
  }

  const order = ["AA", "KK", "QQ", "JJ", "AKs", "AKo"];
  const premiumFreq: PremiumFreqStat[] = order.map((label) => {
    const g = groups[label] || { count: 0, sdWon: 0, sdLost: 0 };
    const sdTotal = g.sdWon + g.sdLost;
    const wsdPct = sdTotal > 0 ? Math.round((g.sdWon / sdTotal) * 1000) / 10 : 0;
    const theoryCount = Math.round(totalHands * THEORY_FREQ[label] / 100 * 10) / 10;
    return { label, count: g.count, theoryCount, wsdPct };
  });

  // 指标 3：各街「新击中/增强到两对+但摊牌输了」的次数
  // 口径 A（宽）：该街 ≥ 两对 且 (上一街 < 两对 或 该街牌力比上一街强)
  const TWO_PAIR = 2;   // evaluate 返回的 category，2 = 两对
  const streetTwoPair: StreetTwoPairStat[] = (["flop", "turn", "river"] as const).map((street) => {
    let reachedCount = 0, deadCount = 0;
    for (const h of hands) {
      if (!h.showdown) continue;                    // 只看摊牌的手
      const heroCards = h.heroCards.split(/\s+/).map(parseCard).filter((c) => c >= 0);
      if (heroCards.length !== 2) continue;

      // 当前街 board 与上一街 board
      const curBoardStr = street === "flop" ? h.flopBoard : street === "turn" ? h.turnBoard : h.riverBoard;
      const prevBoardStr = street === "flop" ? "" : street === "turn" ? h.flopBoard : h.turnBoard;
      if (!curBoardStr) continue;

      const curBoard = boardToCards(curBoardStr);
      const prevBoard = prevBoardStr ? boardToCards(prevBoardStr) : [];
      const expectedLen = street === "flop" ? 3 : street === "turn" ? 4 : 5;
      if (curBoard.length < expectedLen) continue;

      const curRank = evaluate([...heroCards, ...curBoard]);
      if (curRank[0] < TWO_PAIR) continue;

      const prevRank = prevBoard.length > 0
        ? evaluate([...heroCards, ...prevBoard])
        : evalCategory(heroCards);

      const crossedThreshold = prevRank[0] < TWO_PAIR;
      const upgraded = compareRanks(curRank, prevRank) > 0;
      if (crossedThreshold || upgraded) {
        reachedCount++;
        // deadCount 语义：摊牌输掉 pot（heroWon===0），与 W$SD 口径一致。
        // 用 result<0 会把"赢了小 pot 但净亏（重抽水）"误记为输。
        if (h.heroWon === 0) deadCount++;
      }
    }
    return { street, reachedCount, deadCount };
  });

  return { totalHands, premiumFreq, streetTwoPair };
}

