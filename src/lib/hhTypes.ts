/* ================================================================
   hhTypes —— 解析结果共享类型（客户端/服务端共用）
   防泄漏边界说明：本文件只含 interface/type，编译期擦除，可安全被
   前端 bundle 引用。解析器实现永远在 handHistory.ts（服务端专属）。
   ================================================================ */

export interface StreetActionSnapshot {
  sawStreet: boolean;            // hero saw this street
  isAggressor: boolean;          // hero is the preflop raiser (CBet/FvCB premise)
  isIP: boolean | null;          // hero relative position vs preflop raiser
  // CBet: hero is preflop raiser, bet/raised this street
  cbetOpp: boolean;              // hero is preflop raiser + saw street
  didCbet: boolean;
  // FvCB: hero is NOT preflop raiser, faced a c-bet from the raiser
  facingCbet: boolean;
  didFoldVsCbet: boolean;
  didCallVsCbet: boolean;
  // Donk / general actions (not role-dependent)
  betOrRaise: boolean;           // hero bet or raised this street
  heroFirstBettor: boolean;      // hero was the first to bet/raise this street
  heroCalledPriorStreet: boolean;  // hero called a bet on the previous postflop street (Donk premise for turn/river)
  facingBet: boolean;            // hero faced an opponent bet/raise
  foldedToBet: boolean;
  calledBet: boolean;
  raisedBet: boolean;
  checkedThenFacedBet: boolean;  // hero checked first, opponent bet after
  didCheckCall: boolean;
  didCheckRaise: boolean;
  betCount: number;              // AFq
  raiseCount: number;
  callCount: number;
  checkCount: number;
}

export interface ParsedHand {
  id: string;
  date: string;
  table: string;
  stakes: string;
  heroPosition: string;
  heroCards: string;
  heroChipsStart: number;
  heroChipsEnd: number;
  actions: string[];
  preflopActions: string[];
  flopActions: string[];
  turnActions: string[];
  riverActions: string[];
  result: number;            // game profit in BB (rounded, kept for compat)
  gameUSDRaw: number;        // game profit in USD (unrounded — authoritative)
  investedBB: number;
  showdown: boolean;
  sawFlop: boolean;
  threeBet: boolean;
  facingRaise: boolean;
  stealAttempt: boolean;          // hero 在 steal 位 open raise（前面所有人弃牌）
  stealPosition: "CO" | "BTN" | "SB" | null;  // steal 机会的位置
  stealOpp: boolean;              // hero 在 steal 位且前面所有人弃牌（机会，无论 hero 是否 raise）
  // 翻前细分（批次2）
  isOpenRaiser: boolean;          // hero 是翻前第一个 raise 的人
  isRFI: boolean;                 // hero 是 Raise First In（前面无人自愿入池时的首次加注）；isOpenRaiser 且无对手在 hero 之前 call/raise
  rfiOpportunity: boolean;        // hero 有 RFI 机会（hero 行动前无人自愿入池）；isRFI 的分母条件
  openRaiserPos: string;          // 开池者位置（hero 是 open raiser 时=heroPosition；否则=对手位置如 MP/CO/BTN，6-max 最早位是 UTG）
  limpersBeforeFirstRaise: number;// 首 raise 前的 limper 数（0 = 纯净开池防守场景，排除 limp+iso）
  openRaiseToBB: number | null;   // 本手第一个 raise 的 raise-to 尺寸（÷bb，如 2.5）；无 raise（纯 limp 池）= null。BB 防守按开注尺寸分桶用
  facedOpenRaiseAndCalled: boolean; // hero 在 BB 面对 open raise（无 limper）且 call → BB 防守 call 信号
  facingThreeBet: boolean;        // hero open raise 后面对 3bet
  foldedToThreeBet: boolean;      // 上述情况下 hero fold
  isFourBet: boolean;             // hero 面对对手 3bet 后再 raise（第 4 次加注）
  isFiveBet: boolean;             // hero 面对对手 4bet 后再 raise（第 5 次及以上加注）
  facingFourBet: boolean;         // hero 3bet 后面对 4bet
  foldedToFourBet: boolean;       // 上述情况下 hero fold
  isSqueeze: boolean;             // hero squeezed (cold-raise with caller in)
  squeezeOpp: boolean;            // hero had squeeze opportunity
  canFourBet: boolean;            // hero faced a 3bet (4bet opportunity)
  fourBetIP: boolean;             // hero IP when facing 3bet (4bet opportunity)
  fourBetOOP: boolean;            // hero OOP when facing 3bet
  threeBetVsRaiserIP: boolean;
  threeBetVsRaiserOOP: boolean;
  flopStreet: StreetActionSnapshot;
  turnStreet: StreetActionSnapshot;
  riverStreet: StreetActionSnapshot;
  summary: string;
  rake: number;
  jackpot: number;
  potTotal: number;
  heroRake: number;
  heroJackpot: number;
  heroWon: number;               // raw amount Hero was credited (post-rake collected/won)
  heroAiiPremium: number;        // Hero's All-in Insurance premium paid
  heroAiiCompensation: number;   // Hero's All-in Insurance compensation received
  cashDrop: number;              // Cash Drop promotion added to pot (field only; not yet stripped from profit)
  flopBoard: string;             // flop community cards, e.g. "Th 5c 2d"（跑两次时=第一条牌面）
  turnBoard: string;             // flop + turn cards
  riverBoard: string;            // flop + turn + river cards
  // 跑两次（Run It Twice，GG 只在两人全押的大底池出现）的第二条牌面；
  // 未跑两次恒为空串。统计口径仍以第一条为准，这三个字段仅供展示与 EV。
  flopBoard2: string;            // 第二条牌面的翻牌（3 张）
  turnBoard2: string;            // 第二条牌面的翻牌+转牌（4 张）
  riverBoard2: string;           // 第二条牌面的翻牌+转牌+河牌（5 张）
  flopBoard3: string;            // 跑三次第三条牌面的翻牌（3 张）
  turnBoard3: string;            // 跑三次第三条牌面的翻牌+转牌（4 张）
  riverBoard3: string;           // 跑三次第三条牌面的翻牌+转牌+河牌（5 张）
  allInEV: number | null;        // All-in EV profit in BB (pre-rake). null = not an all-in showdown hand; use gameBB
  numSeats: number;              // 该手实际入座人数（header Seat 行去重计数，如 6）。用于桌上人数筛选
  raw: string;                   // 该手原始牌谱文本（已去重）。回放弹窗、底池类型/底池人数等二次解析的输入
}

// 翻后单条街的聚合统计（批次3）
export interface StreetAggStats {
  cbet: number;        // CBet 率 %
  cbetIP: number;      // CBet IP 率 %
  cbetOOP: number;     // CBet OOP 率 %
  fvc: number;         // FvCB (Fold to CBet) 率 %
  fvcIP: number;
  fvcOOP: number;
  donk: number;        // Donk 率 %
  checkC: number;      // Check-Call 率 %
  checkR: number;      // Check-Raise 率 %
  afq: number;         // Aggression Frequency %
}

export interface SessionStats {
  totalHands: number;
  handsPlayed: number;
  handsWon: number;
  handsLost: number;
  totalProfitBB: number;          // pre-rake BB profit (game)
  netProfitBB: number;            // post-rake/jp BB profit
  totalProfitCurrency: number;    // net USD profit (post-rake/jp)
  gameProfitCurrency: number;     // game profit before rake/jp deduction
  totalHeroRakeBB: number;
  totalHeroJackpotBB: number;
  bbPer100: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  stealTotal: number;       // Steal 总尝试率 %
  stealCO: number;
  stealBTN: number;
  stealSB: number;
  // 翻前细分（批次2）
  threeBetIP: number;       // 3Bet IP 率 %
  threeBetOOP: number;      // 3Bet OOP 率 %
  fourBet: number;          // 4Bet 率 %
  fourBetIP: number;
  fourBetOOP: number;
  squeeze: number;          // Squeeze 率 %
  foldToThreeBet: number;   // Fold to 3Bet 率 %
  foldToFourBet: number;    // Fold to 4Bet 率 %
  flop: StreetAggStats;     // 翻后各街（批次3）
  turn: StreetAggStats;
  river: StreetAggStats;
  wonShowdown: number;
  lostShowdown: number;
  wonWithoutShowdown: number;
  biggestWin: number;
  biggestLoss: number;
  profitHistory: { hand: number; profit: number }[];      // pre-rake
  netProfitHistory: { hand: number; profit: number }[];    // post-rake
  sdHistory: { hand: number; profit: number }[];
  nsdHistory: { hand: number; profit: number }[];
  evHistory: { hand: number; profit: number }[];           // All-in EV (pre-rake)
  hourlyRate: number;
  totalHours: number;
  totalRake: number;              // total table rake
  totalHeroRake: number;          // Hero's share of rake
  totalJackpot: number;           // total table jackpot
  totalHeroJackpot: number;        // Hero's share of jackpot
  avgStakes: string;
  wtsd: number;
  wwsf: number;
  wsd: number;
}

// 服务端解析 API 的原文位置（GG 格式：客户端持有原文，服务端只回传区间，省近一半下载量）
export interface RawRange {
  id: string;
  start: number;
  end: number;
}
