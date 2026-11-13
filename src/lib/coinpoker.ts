/* ================================================================
   CoinPoker → GGPoker 牌谱文本转译层
   ================================================================

   ban2note 的整条解析管线（统计/翻前细分/翻后街快照/All-in EV/回放/
   分享图）都围绕 GGPoker 文本格式构建，并经 2500 万手对拍验证。
   CoinPoker 支持不重写这条管线，而是在 parseGGHandHistory() 入口处
   把 CoinPoker 文本转译成 GG 同构文本，下游零改动全量复用。

   两种格式的同构部分（透传）：
     • Table 'X' N-max Seat #N is the button
     • Seat N: NAME ($chips in chips)
     • Dealt to Hero [9c Ah]（对手行无牌，解析器本来就不读）
     • NAME: folds / checks / calls $X / bets $X / raises $X to $Y
     • *** HOLE CARDS / FLOP / TURN / RIVER / SHOWDOWN / SUMMARY ***
       （TURN/RIVER 行 "[旧公共牌] [新牌]" 的双括号写法与 GG 一致）
     • NAME: shows [Js 4c] (Full House) / NAME collected $X from pot
     • Total pot $X | Rake $Y、SUMMARY 的 Seat N: ... won ($X) / folded before Flop

   差异部分（改写）：
     • 头行  CoinPoker Hand #123: NLH (₮0.01/₮0.02) 2026/09/19 … CST
           → Poker Hand #CP123: NLH ($0.01/$0.02 USD) 2026/09/19 … CST
           （#CP 前缀避免与 GG 牌谱 id 撞车导致跨格式误去重）
     • 货币 ₮(USDT) / ₣(CHP) → $（纯符号替换，数值口径不变；结果页金额
       单位跟随 GG 文案显示 $，对 CoinPoker 实为 USDT，数值一致）
     • posts ante $X → posts the ante $X（GG 下游只认带 the 的写法；
       2026-10-22 guazi 样本实证：不改写则 ante 完全不计投入，97.5% 手
       Hero 盈亏虚高一个 ante，报表虚高 9.4 倍）
     • posts auto big blind $X → posts big blind $X（CoinPoker 任意位
       自动补大盲 = 死盲注；GG 同功能导出就叫 posts big blind）
     • ALLIN $X（CoinPoker 金额 = 本次新投入的增量）按上下文归类成 GG
       的三种全押写法：bets $X all-in / raises $INC to $TOT all-in /
       calls $X all-in（需逐行维护街内投入与当前注额）
     • RETURN $X → Uncalled bet ($X) returned to NAME（未跟注退款，
       解析器按该行从投入里扣回）
     • *** FIRST/SECOND/THIRD FLOP/TURN/RIVER/SHOWDOWN *** → 街重置
       正则放行（GG 下游 board 解析本就按这些前缀读双板/三板面；
       2026-10-22 实证：不放行则 streetInv 串街，all-in RIT 手投入
       虚高一次翻前 streetInv，440 手 run-two-times 中 62 手对不上）

   逐行状态机维护「本街投入」：blind/raises-to 为 SET（to=本街总额），
   calls/bets/ALLIN 为 ADD（增量）；街标记（FLOP/TURN/RIVER）处清零。
   这与 handHistory.ts 投入追踪的 SET/ADD 语义严格对应，退款后总投入
   恒等于 Total pot 可在测试中对拍。

   限制（v1）：
     • 只转译 NLH；PLO 等其他玩法整手跳过（下游评估器只支持德扑）
     • straddle 的 CoinPoker 写法（动作行 "xxx: STRADDLE $X"）原样透传——
       下游不认该动词，hero straddle 的投入不会被计入（潜在坑，样本中
       hero 未 straddle 故未咬到）；ante 与 run-it-twice（FIRST/SECOND/
       THIRD 前缀）已支持（guazi 大样本 2026-10-22 实证修复）；
       MEGA SPLASH 彩金行透传，中池即收益；其固定费用 "Splash Fee $x"
       由下游解析进 jackpot 桶（同 GG 的 "Jackpot $x" 彩金费用口径）
     • 玩家名按 GG 口径不含空格（CoinPoker 导出的对手是十六进制 ID，
       自己固定写 Hero，天然满足）
   ================================================================ */

const COINPOKER_HEADER_RE = /^CoinPoker Hand #(\w+):\s*(\S+)\s*\(([^)]*)\)\s*(.*)$/;

function cpNum(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

function cpRound2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cpFmt(n: number): string {
  return cpRound2(n).toFixed(2);
}

export function isCoinPokerHistory(text: string): boolean {
  return /(^|\r?\n)\s*CoinPoker Hand #\w+:/.test(text);
}

export function coinpokerToGG(text: string): string {
  const out: string[] = [];
  // 非 NLH（PLO 等）整手丢弃：下游没有奥马哈评估，喂进去只会产出错误数据
  let skipping = false;
  let street: "preflop" | "flop" | "turn" | "river" | "after" = "preflop";
  // 本街投入（街内总额）：blind/raises-to SET，calls/bets/ALLIN ADD
  const streetInv = new Map<string, number>();
  let currentBet = 0; // 本街已被下注的最高总额

  const resetStreet = () => {
    streetInv.clear();
    currentBet = 0;
  };
  const invOf = (p: string) => streetInv.get(p) ?? 0;

  for (const rawLine of text.split(/\r?\n/)) {
    // 货币符号归一：₮/₣ → $（GG 解析正则全按 $ 抓金额）
    const line = rawLine.replace(/[₮₣]/g, "$").trimEnd();

    const header = line.match(COINPOKER_HEADER_RE);
    if (header) {
      skipping = header[2] !== "NLH";
      street = "preflop";
      resetStreet();
      if (!skipping) {
        // 无论币种符号写成 ₮/₣ 还是省略，统一重建 GG 头行的 ($sb/$bb USD)
        const num = (s: string) => (s.match(/[\d.,]+/) || ["0"])[0];
        const [sbTok, bbTok] = header[3].split("/");
        out.push(
          // 注意：stakes 必须紧贴右括号（GG 头行写法），不能塞 " USD" 之类后缀
          `Poker Hand #CP${header[1]}: ${header[2]} ($${num(sbTok)}/$${num(bbTok ?? "0")}) ${header[4]}`.trimEnd(),
        );
      }
      continue;
    }
    if (skipping) continue;

    if (/^\*\*\* (?:FIRST |SECOND |THIRD )?(FLOP|TURN|RIVER) \*\*/.test(line)) {
      resetStreet();
      street = line.includes("FLOP") ? "flop" : line.includes("TURN") ? "turn" : "river";
      out.push(line);
      continue;
    }
    if (/^\*\*\* (?:FIRST |SECOND |THIRD )?(SHOWDOWN|SUMMARY) \*\*/.test(line)) {
      street = "after";
      out.push(line);
      continue;
    }

    const act = line.match(/^(\S+?):\s+(.+)$/);
    if (act) {
      const player = act[1];
      const a = act[2];
      if (street !== "after") {
        // 盲注（含任意位自动补大盲 → 死盲注）
        const blindM = a.match(/^posts (?:auto )?(small|big) blind \$([\d.,]+)$/);
        if (blindM) {
          const amt = cpNum(blindM[2]);
          streetInv.set(player, amt);
          currentBet = Math.max(currentBet, amt);
          out.push(`${player}: posts ${blindM[1]} blind $${cpFmt(amt)}`);
          continue;
        }
        // ante：GG 下游只认 posts the ante（ ante 走独立累计，不进街内投入）
        const anteM = a.match(/^posts ante \$([\d.,]+)$/);
        if (anteM) {
          out.push(`${player}: posts the ante $${cpFmt(cpNum(anteM[1]))}`);
          continue;
        }
        const raiseM = a.match(/^raises \$([\d.,]+) to \$([\d.,]+)$/);
        if (raiseM) {
          const to = cpNum(raiseM[2]);
          streetInv.set(player, to);
          currentBet = Math.max(currentBet, to);
          out.push(line);
          continue;
        }
        const addM = a.match(/^(calls|bets) \$([\d.,]+)$/);
        if (addM) {
          streetInv.set(player, cpRound2(invOf(player) + cpNum(addM[2])));
          currentBet = Math.max(currentBet, invOf(player));
          out.push(line);
          continue;
        }
        // ALLIN 增量 → GG 三种全押写法之一
        const allinM = a.match(/^ALLIN \$([\d.,]+)$/);
        if (allinM) {
          const amt = cpNum(allinM[1]);
          const prior = invOf(player);
          const newTotal = cpRound2(prior + amt);
          let ggLine: string;
          if (currentBet <= 1e-9 && prior <= 1e-9) {
            ggLine = `${player}: bets $${cpFmt(amt)} all-in`;
          } else if (newTotal > currentBet + 1e-9) {
            ggLine = `${player}: raises $${cpFmt(newTotal - currentBet)} to $${cpFmt(newTotal)} all-in`;
          } else {
            ggLine = `${player}: calls $${cpFmt(amt)} all-in`;
          }
          streetInv.set(player, newTotal);
          currentBet = Math.max(currentBet, newTotal);
          out.push(ggLine);
          continue;
        }
        // 未跟注退款
        const retM = a.match(/^RETURN \$([\d.,]+)$/);
        if (retM) {
          const amt = cpNum(retM[1]);
          streetInv.set(player, Math.max(0, cpRound2(invOf(player) - amt)));
          currentBet = Math.max(0, ...streetInv.values());
          out.push(`Uncalled bet ($${cpFmt(amt)}) returned to ${player}`);
          continue;
        }
      }
      // folds / checks / shows / mucks 等与 GG 同构
      out.push(line);
      continue;
    }

    out.push(line);
  }
  return out.join("\n");
}
