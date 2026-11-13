/* ================================================================
   单手牌谱回放 — 纯逻辑模块（无 React）
   ================================================================
   输入一手牌的原始牌谱文本（ParsedHand.raw），解析出回放弹窗所需的
   全部结构：座位（含位置 / 筹码 / 亮牌）、按钮位、桌型、逐街行动路线
   （含金额与街初底池）、公共牌、赢家。

   解析口径（与牌谱逐行正则一一对应，改动前先想清楚）：
   - raw 可能是多手拼接：按下一手「Hand #」牌头切开，只解析第一手；
   - 在 *** SUMMARY *** 处截断：摘要区同样有 "Seat N: 名字 (...)"，
     不截断会把 6 人桌读成 12 人，位置全错；
   - 跑两次（run it twice）的第二条牌面不单独成列，收池按玩家去重；
   - 未被跟注的加注会退回（Uncalled bet 行），不扣回底池会多算；
   - 红包桌（Cash Drop to Pot 行）：GG 注入底池的额外现金不是玩家行动，
     不进路线，只计入 pot 与 cashDrop 字段——漏掉会让各街底池全少一截。
   ================================================================ */

// 「$1,234.56」→ 1234.56
export function numOr0(s: string | number | null | undefined): number {
  if (!s) return 0;
  return parseFloat(String(s).replace(/,/g, "")) || 0;
}

// 金额换算 BB 的显示串；bb 非法时返回空串（调用方自行兜底「—」）
export function amountToBB(amount: number, bb: number): string {
  if (!(bb > 0)) return "";
  const n = Math.round((amount / bb) * 10) / 10;
  return String(Math.round(n * 100) / 100);
}

// 「2026/01/05 12:03:00」→ 时间戳；解析失败返回 +Infinity（排序时沉底）
export function handTimestamp(date: string): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const ts = Date.parse(date.replace(/\//g, "-"));
  return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
}

// 「2026/01/05 12:03:00」→「01/05 12:03」；解析不出来就原样显示
export function stampDate(date: string): string {
  return (date || "").replace(/^\d{4}\//, "").slice(0, 11);
}

// 水后净盈利（bb）：游戏盈利扣游戏抽水 / JP 抽水，再计入全下保险收支。
// 与「数据总览」的水后百手同源；stakes 解析不出大盲的手牌不参与统计。
export function handNetBB(hand: {
  gameUSDRaw: number;
  heroRake: number;
  heroJackpot: number;
  heroAiiPremium: number;
  heroAiiCompensation: number;
  stakes: string;
}): number {
  const bb = parseFloat((hand.stakes || "").split("/")[1] || "") || 0;
  if (!(bb > 0)) return 0;
  const usd =
    (hand.gameUSDRaw || 0) -
    (hand.heroRake || 0) -
    (hand.heroJackpot || 0) -
    (hand.heroAiiPremium || 0) +
    (hand.heroAiiCompensation || 0);
  return usd / bb;
}

/* ----------------------------------------------------------------
   位置推算：按「按钮后第一个座位 = SB」环绕排位置名。
   sortedSeats 是牌谱 header 里全部座位号升序；与翻前统计用的
   computeHeroPosition 不同，这里要求每个座位都有位置（包括弃牌玩家），
   因为回放桌面上每个座位都要挂牌。
   ---------------------------------------------------------------- */
export function seatPositionName(sortedSeats: number[], buttonSeat: number, seat: number): string {
  const n = sortedSeats.length;
  if (n < 2) return "";
  const btnIdx = sortedSeats.indexOf(buttonSeat);
  if (btnIdx < 0) return "";
  // 按钮后第 1..n 个座位（不含按钮本身），即行动顺序
  const order: number[] = [];
  for (let u = 1; u <= n; u++) order.push(sortedSeats[(btnIdx + u) % n]);
  const a = order.indexOf(seat);
  // heads-up：按钮位是 SB，另一个是 BB
  if (n === 2) return seat === buttonSeat ? "SB" : a === 0 ? "BB" : "";
  if (a < 0) return "";
  if (a === 0) return "SB";
  if (a === 1) return "BB";
  if (a === n - 1) return "BTN";
  // 中间位置按桌型命名：s = BB 之后、BTN 之前的空位数
  const s = n - 3;
  if (s <= 0) return "BTN";
  const NAMES: Record<number, string[]> = {
    6: ["UTG", "UTG+1", "UTG+2", "MP", "HJ", "CO"],
    5: ["UTG", "UTG+1", "MP", "HJ", "CO"],
    4: ["UTG", "MP", "HJ", "CO"],
    // 6-max 与主解析器 computeHeroPosition 的 UTG/MP/CO 口径一致
    3: ["UTG", "MP", "CO"],
    2: ["UTG", "CO"],
  };
  return NAMES[s]?.[a - 2] ?? "CO";
}

/* ----------------------------------------------------------------
   回放解析结果类型
   ---------------------------------------------------------------- */
export interface ReplaySeat {
  seat: number;
  name: string;
  stack: number;
  pos: string;
  isHero: boolean;
  isBtn: boolean;
  cards: string; // 摊牌亮牌；Hero 的底牌由行数据补
}

export interface ReplayAct {
  actor: string;
  pos: string;
  seat: number | "";
  isHero: boolean;
  kind: "post" | "fold" | "check" | "call" | "raise" | "bet" | "show" | "collect" | "other";
  amt: number;
  name: string; // 行动的中文显示名（下注 / 加注 / 让牌…）
}

export interface ReplayStreet {
  key: string; // preflop / flop / turn / river
  label: string; // 翻牌前 / 翻牌 / 转牌 / 河牌
  board: string; // 该街结束时的全部公共牌
  boardNew: string; // 本街新发出的公共牌
  // 跑两次（run it twice）第二条牌面：未跑两次恒为空串
  board2: string; // 第二条牌面该街结束时的全部公共牌
  board2New: string; // 第二条牌面本街新发出的公共牌
  // 跑三次（run it three times）第三条牌面：未跑三次恒为空串
  board3: string; // 第三条牌面该街结束时的全部公共牌
  board3New: string; // 第三条牌面本街新发出的公共牌
  acts: ReplayAct[];
  potBefore: number; // 本街开始时的底池（$）
}

export interface ReplayHand {
  seats: ReplaySeat[];
  buttonSeat: number | null;
  maxSeats: number;
  streets: ReplayStreet[];
  blindsTotal: number;
  cashDrop: number; // 红包桌庄家注入底池的额外现金（$）；普通桌为 0
  board: string; // 河牌结束时的全部公共牌
  board2: string; // 跑两次第二条牌面的全部公共牌；未跑两次为空串
  board3: string; // 跑三次第三条牌面的全部公共牌；未跑三次为空串
  winner: { actor: string; amt: number } | null;
  winners: string[];
}

function actKindOf(text: string): ReplayAct["kind"] {
  const t = (text || "").trim();
  if (/^posts /.test(t)) return "post";
  if (/^folds/.test(t)) return "fold";
  if (/^checks/.test(t)) return "check";
  if (/^calls/.test(t)) return "call";
  if (/^raises/.test(t)) return "raise";
  // 「Bet & Muck folds」= 输家摊牌前盖牌的 GG 标记，不是下注——
  // 只有带金额（$X / $X to $Y）的 Bet & Muck 才是下注，无金额的落入 other 被跳过
  if (/^Bet & Muck \$/.test(t) || /^bets/.test(t)) return "bet";
  if (/^shows/.test(t)) return "show";
  if (/^collected/.test(t)) return "collect";
  return "other";
}

function actNameOf(text: string): string {
  const t = (text || "").trim();
  if (/^posts small blind/.test(t)) return "小盲";
  if (/^posts big blind/.test(t)) return "大盲";
  if (/^posts the ante/.test(t)) return "前注";
  if (/^folds/.test(t)) return "弃牌";
  if (/^checks/.test(t)) return "让牌";
  if (/^calls/.test(t)) return "跟注";
  if (/^raises/.test(t)) return "加注";
  if (/^Bet & Muck/.test(t) || /^bets/.test(t)) return "下注";
  if (/^collected/.test(t)) return "获胜";
  if (/^shows/.test(t)) return "亮牌";
  return t;
}

function actAmtOf(text: string): number {
  let m = text.match(/^posts (?:small blind|big blind|the ante) \$([\d.,]+)/);
  if (m) return numOr0(m[1]);
  m = text.match(/^raises \$[\d.,]+ to \$([\d.,]+)/);
  if (m) return numOr0(m[1]);
  m = text.match(/^Bet & Muck \$[\d.,]+ to \$([\d.,]+)/);
  if (m) return numOr0(m[1]);
  m = text.match(/^(?:calls|bets|Bet & Muck) \$([\d.,]+)/);
  if (m) return numOr0(m[1]);
  m = text.match(/^collected \$([\d.,]+)/);
  if (m) return numOr0(m[1]);
  return 0;
}

export function parseHandForReplay(rawText: string): ReplayHand {
  // ── 只解析「第一手」：raw 可能是多手拼接（按下一手牌头切开）
  // ── 在 *** SUMMARY *** 处截断：摘要区里同样是 "Seat N: 名字 (...)"，
  //    若不截断会被当成额外座位 —— 一手 6 人桌会读成 12 人，位置也全算错
  let full = String(rawText || "").replace(/\r\n/g, "\n");
  const nextHand = full.search(/\n(?=Poker(?:Stars Zoom)? Hand #)/);
  if (nextHand >= 0) full = full.slice(0, nextHand);
  const summaryIdx = full.indexOf("*** SUMMARY");
  const summary = summaryIdx >= 0 ? full.slice(summaryIdx) : "";
  if (summaryIdx >= 0) full = full.slice(0, summaryIdx);
  // GG 导出偶发把小数点写成 NUL/退格（实测：bets $0\x0005 应为 $0.05，见 RC4794780246）。
  // 数字之间的 NUL/退格还原为小数点，其余剥除；不清洗会让行动徽标金额解析成 0
  full = full
    .replace(/(\d)\u0000(\d)/g, "$1.$2")
    .replace(/(\d)\x08(\d)/g, "$1.$2")
    .replace(/[\u0000\x08]/g, "");
  const lines = full.split("\n").map((l) => l.trim()).filter(Boolean);

  const seats: { seat: number; name: string; stack: number }[] = [];
  const seenSeat: Record<number, boolean> = {};
  let buttonSeat: number | null = null;
  let maxSeats = 0;
  let heroName = "";
  const addSeat = (seat: number, name: string, stack: number) => {
    if (seenSeat[seat]) return;
    seenSeat[seat] = true;
    seats.push({ seat, name, stack: stack || 0 });
  };
  for (const line of lines) {
    // GG 会给每个玩家都写一行 Dealt to，但只有 Hero 那行带自己的手牌（[Ks Kc]）；
    // 取任意一行会把最后一个座位当成 Hero，Hero 位置与赢家高亮全错
    const dealt = line.match(/^Dealt to (\S+)\s*\[[^\]]*\]/);
    if (dealt) {
      heroName = dealt[1];
      continue;
    }
    if (/^Dealt to \S+\s*$/.test(line)) continue;
    const seatFull = line.match(/^Seat (\d+): (\S+)\s*\(\$([\d.,]+)/);
    if (seatFull) {
      addSeat(parseInt(seatFull[1], 10), seatFull[2], numOr0(seatFull[3]));
      continue;
    }
    const seatBare = line.match(/^Seat (\d+): (\S+)\s*\(/);
    if (seatBare) {
      addSeat(parseInt(seatBare[1], 10), seatBare[2], 0);
      continue;
    }
    // 座位号按钮与 N-max 在同一行，两者都要取：匹配到 button 就跳过的话，
    // N-max 永远读不到，最大人数会退化成「座位数」
    const btn = line.match(/Seat #(\d+) is the button/);
    if (btn) buttonSeat = parseInt(btn[1], 10);
    const max = line.match(/(\d+)-max/);
    if (max) maxSeats = parseInt(max[1], 10);
  }

  const sortedSeatNos = seats.map((x) => x.seat).sort((a, b) => a - b);
  if (!maxSeats) maxSeats = sortedSeatNos.length;
  // 牌桌环绕顺序按座位号（GG 牌谱的座位号就是顺时针序）；
  // 按位置名排序会把 HJ / MP 这类相邻位置颠倒，环上就会有两名玩家换位
  const seatViews: ReplaySeat[] = seats
    .map((x) => ({
      seat: x.seat,
      name: x.name,
      stack: x.stack || 0,
      pos: sortedSeatNos.length >= 2 && buttonSeat !== null
        ? seatPositionName(sortedSeatNos, buttonSeat, x.seat)
        : "",
      isHero: heroName ? x.name === heroName : x.name === "Hero",
      isBtn: buttonSeat !== null && x.seat === buttonSeat,
      cards: "",
    }))
    .sort((a, b) => a.seat - b.seat);

  const byName: Record<string, ReplaySeat> = {};
  for (const s of seatViews) byName[s.name] = s;

  const streets: ReplayStreet[] = [];
  let cur: ReplayStreet = {
    key: "preflop", label: "翻牌前", board: "", boardNew: "", board2: "", board2New: "", board3: "", board3New: "", acts: [], potBefore: 0,
  };
  streets.push(cur);
  // 每条街重置本街投入：commit 跨街累计的话，翻后「raises $a to $b」会减掉
  // 玩家翻前的投入，各街底池被少算
  let commit: Record<string, number> = {};
  let pot = 0;
  let blinds = 0;
  let cashDrop = 0;
  let lastBoard = "";
  let lastBoard2 = "";
  let lastBoard3 = "";
  let winner: { actor: string; amt: number } | null = null;
  const winners: string[] = [];
  let rit2 = false; // run it twice / three times：已进入第二场
  const seenStreet: Record<string, boolean> = {};

  for (const line of lines) {
    const st = line.match(/^\*\*\* (FIRST |SECOND |THIRD )?(FLOP|TURN|RIVER)/);
    if (st) {
      // 跑两次(run it twice)：第二条牌面的街不单独成列、不覆盖公共牌，
      // 并入同 key 街的 board2 / board2New 供回放与牌谱表双牌面展示；
      // 跑三次(run it three times)的 THIRD 线写 board3，不覆盖 board2。
      // 同时打 rit2 标记，第二/三场的收池要合并到该玩家已有收池行（金额累加），
      // 否则同一玩家赢两条/三条牌面时只显示一半金额、第三场收池被吞掉
      if (st[1] === "SECOND " || st[1] === "THIRD ") {
        rit2 = true;
        const key2 = st[2].toLowerCase();
        const bs2 = (line.match(/\[([^\]]+)\]/g) || []).map((x) => x.slice(1, -1));
        const target = streets.find((x) => x.key === key2);
        if (target && bs2.length) {
          if (st[1] === "THIRD ") {
            target.board3 = bs2.join(" ");
            target.board3New = bs2[bs2.length - 1];
            lastBoard3 = target.board3;
          } else {
            target.board2 = bs2.join(" ");
            target.board2New = bs2[bs2.length - 1];
            lastBoard2 = target.board2;
          }
        }
        continue;
      }
      const key = st[2].toLowerCase();
      if (seenStreet[key]) continue;
      seenStreet[key] = true;
      commit = {};
      // 转牌/河牌行里带两个方括号，最后一个才是本街新发出的牌
      const boards = (line.match(/\[([^\]]+)\]/g) || []).map((x) => x.slice(1, -1));
      const boardAll = boards.join(" ");
      const boardNew = boards.length ? boards[boards.length - 1] : "";
      cur = {
        key,
        label: key === "flop" ? "翻牌" : key === "turn" ? "转牌" : "河牌",
        board: boardAll,
        boardNew,
        board2: "",
        board2New: "",
        board3: "",
        board3New: "",
        acts: [],
        potBefore: pot,
      };
      streets.push(cur);
      if (boardAll) lastBoard = boardAll;
      continue;
    }
    // 未被跟注的加注会退回：不扣回这笔钱底池会多算，各街列头底池与面板头部底池就对不上。
    // 只修底池与 commit，不改写行动徽标金额——徽标展示的是「对手看到的下注尺寸」，
    // 无人跟注退款后把它清零会让「下注」徽标缺 size（河牌诈唬被弃是最常见场景）
    const uncalled = line.match(/^Uncalled bet \(\$([\d.,]+)\) returned to (\S+)/);
    if (uncalled) {
      const amt = numOr0(uncalled[1]);
      const who = uncalled[2];
      commit[who] = Math.max(0, (commit[who] || 0) - amt);
      pot = Math.max(0, pot - amt);
      continue;
    }
    // 红包桌：庄家额外注入底池的现金（非玩家行动）。计入 pot 让后续街的
    // potBefore 包含它；单独记 cashDrop 供回放弹窗画红包桌标识与红包胶囊
    const drop = line.match(/^Cash Drop to Pot\s*:\s*total\s*\$([\d.,]+)/i);
    if (drop) {
      const amt = numOr0(drop[1]);
      cashDrop += amt;
      pot += amt;
      continue;
    }
    let actor = "";
    let action = "";
    const named = line.match(/^(.+?):\s*(.+)$/);
    if (named) {
      actor = named[1];
      action = named[2].trim();
    } else {
      const post = line.match(/^(\S+) posts .*\$[\d.,]+/);
      if (post) {
        actor = post[1];
        action = line.slice(post[1].length + 1).trim();
      } else {
        const collected = line.match(/^(\S+) collected \$[\d.,]+/);
        if (collected) {
          actor = collected[1];
          action = "collected " + line.slice(line.indexOf("$"));
        } else {
          const mucks = line.match(/^(\S+) mucks/);
          if (mucks) {
            actor = mucks[1];
            action = "mucks";
          }
        }
      }
    }
    if (!actor) continue;
    const kind = actKindOf(action);
    if (kind === "other") continue;
    if (kind === "show") {
      // 亮牌：把牌面挂到座位上（对手摊牌时回放能看到）
      const sh = action.match(/^shows \[([^\]]+)\]/);
      if (sh && byName[actor]) byName[actor].cards = sh[1];
      continue;
    }
    const amt = actAmtOf(action);
    // 跑两次/三次的第二、三场：非收池行不进路线；收池合并到该玩家已有收池行
    // 并累加金额（同玩家赢两条牌面显示总金额，跑三次第三场不再被吞；分池多赢家仍各自保留）
    if (rit2) {
      if (kind !== "collect") continue;
      const priorAct = cur.acts.find((a) => a.actor === actor && a.kind === "collect");
      if (priorAct) {
        priorAct.amt = Math.round((priorAct.amt + amt) * 100) / 100;
        if (winner && winner.actor === actor) winner.amt = priorAct.amt;
        continue;
      }
    }
    if (kind === "post") {
      commit[actor] = (commit[actor] || 0) + amt;
      pot += amt;
      blinds += amt;
    } else if (kind === "call" || kind === "bet") {
      commit[actor] = (commit[actor] || 0) + amt;
      pot += amt;
    } else if (kind === "raise") {
      const prev = commit[actor] || 0;
      pot += amt - prev;
      commit[actor] = amt;
    } else if (kind === "collect") {
      // 跨牌面分池（RIT 第二/三场由另一名玩家收池）：headline winner 取金额
      // 最大者（主池赢家），不再被后到的小额收池整体覆盖（2026-11-03 审查 P3）；
      // winners 列表仍保留全部收池者。
      if (!winner || amt > winner.amt) winner = { actor, amt };
      if (winners.indexOf(actor) < 0) winners.push(actor);
    }
    cur.acts.push({
      actor,
      pos: byName[actor] ? byName[actor].pos : "",
      seat: byName[actor] ? byName[actor].seat : "",
      isHero: byName[actor] ? byName[actor].isHero : false,
      kind,
      amt,
      name: actNameOf(action),
    });
  }
  streets[0].potBefore = blinds + cashDrop;
  // 兜底：摘要前没有 collected 行时，从 *** SUMMARY *** 的 Seat 行认赢家
  // （GG 摘要有 "and won ($x)" / "(small blind) won ($x)" / "collected ($x)" 三种写法，
  // 与主解析器 sumWinningAmounts 的口径对齐）
  if (winners.length === 0 && summary) {
    for (const line of summary.split(/\r?\n/)) {
      const m = line.match(/^Seat \d+: (\S+).*?\b(?:won|collected) \(\$([\d.,]+)\)/);
      if (m) {
        if (winners.indexOf(m[1]) < 0) winners.push(m[1]);
        if (!winner) winner = { actor: m[1], amt: numOr0(m[2]) };
      }
    }
  }
  return {
    seats: seatViews,
    buttonSeat,
    maxSeats,
    streets,
    blindsTotal: blinds,
    cashDrop,
    board: lastBoard,
    board2: lastBoard2,
    board3: lastBoard3,
    winner,
    winners,
  };
}

// 解析结果缓存：逐手牌谱表每行都要解析一次（行动缩写列 / 公共牌列 / 底池列），
// 弹窗再解析第二次就浪费了；按 raw 全文做 key，超上限整体清空。
// 上限要够大：几十万手的会话如果频繁清空，跨筛选的重算会反复全量重解析
const parseMemo = new Map<string, ReplayHand>();
export function parseHandForReplayCached(rawText: string): ReplayHand | null {
  const key = String(rawText || "");
  if (!key) return null;
  const hit = parseMemo.get(key);
  if (hit) return hit;
  const parsed = parseHandForReplay(key);
  if (parseMemo.size > 5000) parseMemo.clear();
  parseMemo.set(key, parsed);
  return parsed;
}

/* ----------------------------------------------------------------
   底池人数：进入翻牌圈的人数（翻前没有弃牌的入池玩家数）；
   没发出翻牌返回 0。
   口径：先截掉下一手牌头与 *** SUMMARY ***（摘要区的 Seat 行会把人数
   算翻倍），按 Seat 行取「本手入池玩家」，再扣掉翻牌街标记之前出现
   folds 的玩家。
   ---------------------------------------------------------------- */
const flopPlayersMemo = new Map<string, number>();
export function flopPlayersCount(rawText: string): number {
  const full0 = String(rawText || "").replace(/\r\n/g, "\n");
  const hit = flopPlayersMemo.get(full0);
  if (hit !== undefined) return hit;
  let full = full0;
  const nextHand = full.search(/\n(?=Poker(?:Stars Zoom)? Hand #)/);
  if (nextHand >= 0) full = full.slice(0, nextHand);
  const summaryIdx = full.indexOf("*** SUMMARY");
  if (summaryIdx >= 0) full = full.slice(0, summaryIdx);
  const lines = full.split("\n");
  const seatNames: string[] = [];
  const seen: Record<string, boolean> = {};
  const folders: Record<string, boolean> = {};
  let sawFlop = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf("*** ") !== 0) {
      const seat = line.match(/^Seat (\d+): (\S+)\s*\(/);
      if (seat) {
        if (!seen[seat[2]]) {
          seen[seat[2]] = true;
          seatNames.push(seat[2]);
        }
        continue;
      }
      const act = line.match(/^(\S+?):\s*(.+)$/);
      if (act && /^folds\b/.test(act[2])) folders[act[1]] = true;
      continue;
    }
    const marker = line.match(/^\*\*\* (?:FIRST |SECOND |THIRD )?(FLOP|TURN|RIVER|SHOWDOWN)/);
    if (!marker) continue;
    if (marker[1] === "FLOP") sawFlop = true;
    break;
  }
  let count = 0;
  if (sawFlop) {
    for (const name of seatNames) {
      if (!folders[name]) count++;
    }
  }
  // 上限对齐大会话（几十万手）：条目只是 字符串引用→数字，内存可忽略，
  // 频繁清空反而导致「查看牌谱」每次重算都全量重解析
  if (flopPlayersMemo.size > 400000) flopPlayersMemo.clear();
  flopPlayersMemo.set(full0, count);
  return count;
}

// 无翻牌 = 本手没有发出翻牌，但 Hero 翻前主动投入过筹码
// （跟注 / 加注 / 下注；盲注与前注不算主动投入）
export function noFlopActiveHand(hand: {
  flopBoard: string;
  preflopActions: string[];
}): boolean {
  if (!hand || hand.flopBoard) return false;
  const acts = hand.preflopActions;
  if (!acts || !acts.length) return false;
  for (const a of acts) {
    const t = String(a || "");
    if (
      /^calls\b/.test(t) || /^raises\b/.test(t) ||
      /^bets\b/.test(t) || /^Bet & Muck\b/.test(t)
    ) {
      return true;
    }
  }
  return false;
}
