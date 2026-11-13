# GGPoker 牌谱格式深度研究 & Ban2Note 解析器技术文档 v4

> **用途：** 供其他 AI 审查 Ban2Note 解析器代码的完整参考  
> **代码：** `bansolver/src/lib/handHistory.ts`（~1440 行）、`bansolver/src/app/tools/ban2note/page.tsx`（~1340 行）  
> **覆盖：** 格式规范、8 种手牌类型、每字段解析逻辑、公式推导、边池/平分底池/二次发牌处理

---

## 〇、牌谱元素速查

```
行 #  │ 内容                                                        │ 解析字段
──────┼─────────────────────────────────────────────────────────────┼────────────
   1  │ PokerStars Zoom Hand #4444533607: Hold'em No Limit           │ handId, gameType
      │ ($0.5/$1) - 2026/04/15 17:18:38                             │ sb, bb, date
   2  │ Table 'RushAndCash2505103' 6-max Seat #1 is the button       │ tableName, btnSeat
  3-8 │ Seat N: NAME ($chips)                                       │ playerNames, stacks
   9  │ NAME: posts small blind $0.5                                 │ blind posters
  10  │ *** HOLE CARDS ***                                          │ preflop start
 11-16│ Dealt to NAME [cards]                                       │ heroCards
 17+  │ NAME: action                                                │ actions
  N  │ *** FLOP *** [cards]                                        │ flop cards
 ...  │ *** TURN *** [cards] / *** RIVER *** [cards]                │
 ...  │ Uncalled bet ($X) returned to NAME                          │ refund
  M  │ *** SHOWDOWN *** / *** FIRST SHOWDOWN *** / *** SECOND SHOWDOWN *** │
 ...  │ NAME collected $X from pot                                  │ result
  Z  │ *** SUMMARY ***                                             │
 Z+1  │ Total pot $X | Rake $Y | Jackpot $Z ...                    │ pot, rake, jp
 Z+2  │ Board [cards]                                               │ board
 Z+3+ │ Seat N: NAME result                                         │ heroResult
```

---

## 一、完整格式规范

### 1.1 头部（HEADER）

```
PokerStars Zoom Hand #4444533607: Hold'em No Limit ($0.5/$1) - 2026/04/15 17:18:38
Poker Hand #RC4240082146: Hold'em No Limit ($0.25/$0.5) - 2026/01/24 15:49:24
```

正则：`/(?:Poker(?:Stars Zoom)?) Hand #(\w+):.*\(\$([\d.]+)\/\$([\d.]+)\).*(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/`

| 组 | 说明 | 示例 |
|----|------|------|
| `\w+` | 手牌 ID | `4444533607` 或 `RC4240082146` |
| `[\d.]+` (×2) | 小盲/大盲注 ($) | `0.5` / `1` |
| 日期 | `YYYY/MM/DD HH:MM:SS` | `2026/04/15 17:18:38` |

### 1.2 牌桌（TABLE）

```
Table 'RushAndCash2505103' 6-max Seat #1 is the button
```

正则：`/Table '([^']+)'.*Seat #(\d) is the button/` → 表名 + 按钮位

### 1.3 座位（SEATS）

```
Seat 1: 3a0bc8ae ($102.95 in chips)
Seat 2: 4a322990 ($11.1 in chips)
...
Seat 5: Chill ($146.66 in chips)
```

正则：`/Seat (\d+): (\S+) \(\$([\d.]+) in chips\)/` → 座位号 + 玩家名 + 筹码量

### 1.4 盲注（BLINDS）

```
4a322990: posts small blind $0.5
967d6f52: posts big blind $1
```

正则：`/(\S+): posts (small|big) blind \$([\d.]+)/`

### 1.5 发牌（HOLE CARDS）

```
Dealt to Chill [8s Th]        ← Hero 的发牌行（Hero 看到手牌）
Dealt to 3a0bc8ae              ← 别人的发牌行（空，Hero 看不到）
```

正则：`/Dealt to (\S+) (?:\[(.+?)\])?/` → 玩家名 + 手牌（可能为空）

### 1.6 玩家动作（ACTIONS）

格式：`PLAYER: action`

| 动作 | 正则 | 示例 |
|------|------|------|
| 弃牌 | `/folds/` | `Chill: folds` |
| 过牌 | `/checks/` | `Chill: checks` |
| 跟注 | `/calls \$([\d.]+)/` | `Chill: calls $1.5` |
| 加注 | `/raises \$([\d.]+) to \$([\d.]+)/` | `Chill: raises $1.5 to $2.5` |
| 下注 | `/bets \$([\d.]+)/` | `Chill: bets $4` |
| All-in | `/raises \$[\d.]+ to \$[\d.]+ and is all-in/` | `Chill: raises $76.13 to $95.63 and is all-in` |
| 亮牌 | `/shows \[(.+?)\] (.*)/` | `Chill: shows [Ac Ad] (a pair of Aces)` |

### 1.7 街（STREETS）

```
*** FLOP *** [Ah 3s Qc]
*** TURN *** [Ah 3s Qc] [7d]
*** RIVER *** [Ah 3s Qc 7d] [Ks]
```

**二次发牌（Run It Twice）的额外街：**
```
*** FIRST FLOP *** [Jc Ts 7s]
*** FIRST TURN *** [Jc Ts 7s] [4s]
*** FIRST RIVER *** [Jc Ts 7s 4s] [7h]
*** SECOND TURN *** [Jc Ts 7s] [5c]
*** SECOND RIVER *** [Jc Ts 7s 5c] [5s]
```
→ 二次发牌时，SECOND 只有 TURN 和 RIVER（共用 FIRST FLOP）。

### 1.8 反还（RETURN）

```
Uncalled bet ($4) returned to Chill
```

正则：`/returned.*\(?\$([\d.]+)\)?/`

### 1.9 收集（COLLECT）

```
Chill collected $5.23 from pot
```

正则：`/(\S+) collected \$([\d.]+) from pot/`

### 1.10 摊牌（SHOWDOWN）

```
*** SHOWDOWN ***                ← 每手牌都有（包括 walk）
*** FIRST SHOWDOWN ***          ← 二次发牌模式
*** SECOND SHOWDOWN ***
```

### 1.11 总结（SUMMARY）

```
*** SUMMARY ***
Total pot $5.5 | Rake $0.27 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Ah 3s Qc]
Seat 1: 3a0bc8ae (button) folded before Flop (didn't bet)
Seat 2: 4a322990 (small blind) folded before Flop
...
Seat 6: Chill collected ($5.23)
```

SUMMARY 行格式：
- `Seat N: NAME (POS) folded before Flop (didn't bet)` — 翻前弃牌
- `Seat N: NAME (POS) folded on the Flop` — 翻牌弃牌
- `Seat N: NAME (POS) collected ($X)` — 赢取
- `Seat N: NAME (POS) won ($X)` — 赢取（二手发牌/边池）
- `Seat N: NAME showed [cards] and won ($X) with HAND, and won ($Y) with HAND` — 边池（多个 won）
- `Seat N: NAME showed [cards] and lost with HAND, and won ($X) with HAND` — 主池输+边池赢
- `Seat N: NAME showed [cards] and collected ($X) with HAND` — 正常亮牌赢取

---

## 二、8 种手牌类型及完整示例

### 类型 1：WALK（盲注位收池）

Hero 在 BB，所有人弃牌。

```
PokerStars Zoom Hand #4444532142: Hold'em No Limit ($0.5/$1) - 2026/04/15 17:15:02
Table 'RushAndCash2504637' 6-max Seat #1 is the button
Seat 1: Chill ($114.12 in chips)
Seat 2: 9db1d52e ($125.5 in chips)
Seat 3: a29ab766 ($114.54 in chips)
Seat 4: f2d242a6 ($100.28 in chips)
Seat 5: dec1c0cd ($100 in chips)
Seat 6: d575263f ($94.71 in chips)
9db1d52e: posts small blind $0.5
a29ab766: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [3h Jh]
f2d242a6: folds
dec1c0cd: folds
d575263f: folds
Chill: raises $1.5 to $2.5
9db1d52e: folds
a29ab766: folds
Uncalled bet ($1.5) returned to Chill
Chill collected $2.5 from pot
*** SHOWDOWN ***
Chill collected $2.5 from pot
*** SUMMARY ***
Total pot $2.5 | Rake $0.00
Seat 1: Chill (button) collected ($2.5)
```

**解析结果：**
- invested = 2.5 → refund $1.5 → invested = 1.0
- won = $2.5
- net = 2.5 - 1.0 = $1.5 / $1 = +1.5bb
- sawFlop = false（无 `*** FLOP ***`）
- showdown = false（无亮牌，Hero 虽收池但未亮牌）
- VPIP = true（有 raise）
- PFR = true
- 3bet = false（无前加注）

### 类型 2：PREFLOP FOLD（翻前弃牌）

```
Poker Hand #RC4240082118: Hold'em No Limit ($0.25/$0.5) - 2026/01/24 15:49:16
Table 'RushAndCash11298009' 6-max Seat #1 is the button
Seat 1: 4cd654b9 ($52.89 in chips)
Seat 2: 2c11dd5c ($33.3 in chips)
Seat 3: 7f0e49d1 ($54.87 in chips)
Seat 4: Hero ($55.15 in chips)
Seat 5: 43f4a250 ($92.25 in chips)
Seat 6: 15f20985 ($54.59 in chips)
2c11dd5c: posts small blind $0.25
7f0e49d1: posts big blind $0.5
*** HOLE CARDS ***
Dealt to Hero [8c 5s]
Hero: folds
43f4a250: folds
15f20985: folds
4cd654b9: folds
2c11dd5c: raises $1 to $1.5
7f0e49d1: folds
Uncalled bet ($1) returned to 2c11dd5c
*** SHOWDOWN ***
2c11dd5c collected $1 from pot
*** SUMMARY ***
Total pot $1 | Rake $0
Seat 4: Hero folded before Flop (didn't bet)
```

**解析结果：**
- invested = 0
- won = $0
- net = 0bb
- sawFlop = false
- showdown = false
- VPIP = false（fold 不含 calls/raises）
- PFR = false

### 类型 3：PREFLOP WIN（Hero 开池，全部弃牌）

```
PokerStars Zoom Hand #4444532142: Hold'em No Limit ($0.5/$1) - 2026/04/15 17:15:02
Table 'RushAndCash2504637' 6-max Seat #1 is the button
Seat 1: Chill ($114.12 in chips)
Seat 2: 9db1d52e ($125.5 in chips)
Seat 3: a29ab766 ($114.54 in chips)
Seat 4: f2d242a6 ($100.28 in chips)
Seat 5: dec1c0cd ($100 in chips)
Seat 6: d575263f ($94.71 in chips)
9db1d52e: posts small blind $0.5
a29ab766: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [3h Jh]
f2d242a6: folds
dec1c0cd: folds
d575263f: folds
Chill: raises $1.5 to $2.5
9db1d52e: folds
a29ab766: folds
Uncalled bet ($1.5) returned to Chill
Chill collected $2.5 from pot
*** SHOWDOWN ***
Chill collected $2.5 from pot
*** SUMMARY ***
Total pot $2.5 | Rake $0.00
Seat 1: Chill (button) collected ($2.5)
```

**解析结果：** 同 WALK 场景

### 类型 4：SINGLE STREET WIN（翻牌圈对手弃牌）

```
PokerStars Zoom Hand #4444533607: Hold'em No Limit ($0.5/$1) - 2026/04/15 17:18:38
Table 'RushAndCash2505103' 6-max Seat #1 is the button
Seat 1: 3a0bc8ae ($102.95 in chips)
Seat 2: 4a322990 ($11.1 in chips)
Seat 3: 967d6f52 ($218.48 in chips)
Seat 4: 4e3c81ca ($276.76 in chips)
Seat 5: Chill ($146.66 in chips)
Seat 6: 5894afd7 ($138.91 in chips)
4a322990: posts small blind $0.5
967d6f52: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [8s Th]
4e3c81ca: folds
5894afd7: folds
3a0bc8ae: folds
Chill: raises $1.5 to $2.5
4a322990: folds
967d6f52: calls $1.5
*** FLOP *** [Ah 3s Qc]
967d6f52: checks
Chill: bets $4
967d6f52: folds
Uncalled bet ($4) returned to Chill
Chill collected $5.23 from pot
*** SUMMARY ***
Total pot $5.5 | Rake $0.27
Board [Ah 3s Qc]
Seat 6: Chill collected ($5.23)
```

**解析结果：**
- invested = 2.5 (raise SET) → +4 (bet ADD) → -4 (refund) → 2.5
- won = $5.23
- net = 5.23 - 2.5 = $2.73 / $1 = +2.73bb
- sawFlop = true（有 `*** FLOP ***`，Hero 未翻前弃牌）
- showdown = false（无人亮牌）
- personRake = (2.5 / (5.5+0.27)) × 0.27 = 0.12

### 类型 5：SHOWDOWN WIN（摊牌获胜）

```
PokerStars Zoom Hand #4444533349: Hold'em No Limit ($0.5/$1) - 2026/04/15 17:17:48
Table 'RushAndCash2505066' 6-max Seat #1 is the button
Seat 1: 4b88494 ($116.49 in chips)
Seat 2: 3cfe22c5 ($100 in chips)
Seat 3: 30cfa1e1 ($129.43 in chips)
Seat 4: f743ee8 ($298.35 in chips)
Seat 5: Chill ($123.02 in chips)
Seat 6: bb818627 ($120.34 in chips)
3cfe22c5: posts small blind $0.5
30cfa1e1: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [7d 7s]
f743ee8: folds
Chill: raises $1 to $2
bb818627: folds
4b88494: folds
3cfe22c5: folds
30cfa1e1: calls $1
*** FLOP *** [As Qc 8d]
30cfa1e1: checks
Chill: bets $1.41
30cfa1e1: calls $1.41
*** TURN *** [As Qc 8d] [Kh]
30cfa1e1: checks
Chill: checks
*** RIVER *** [As Qc 8d Kh] [7c]
30cfa1e1: bets $1.72
Chill: calls $1.72
*** SHOWDOWN ***
30cfa1e1: shows [Qd Jd] (a pair of Queens)
Chill: shows [7d 7s] (three of a kind, Sevens)
Chill collected $7.43 from pot
*** SUMMARY ***
Total pot $8.00 | Rake $0.57
Board [As Qc 8d Kh 7c]
Seat 5: Chill showed [7d 7s] and collected ($7.43) with three of a kind, Sevens
```

**解析结果：**
- invested = 2.0 (raise) → +1.41 (bet) → +1.72 (call) = $5.13
- won = $7.43
- net = 7.43 - 5.13 = $2.30 / $1 = +2.30bb
- sawFlop = true
- showdown = true（有人亮牌 + Hero 未弃牌）
- W$SD = 此手计入 numerator（赢）
- WTSD = 此手计入 numerator（到摊牌）

### 类型 6：3BET POT（翻前再加注）

```
PokerStars Zoom Hand #4444532637: Hold'em No Limit ($0.5/$1) - 2026/04/15 17:16:16
Table 'RushAndCash2504794' 6-max Seat #1 is the button
Seat 1: Chill ($111.62 in chips)
Seat 2: 5edaf1c2 ($117.2 in chips)
Seat 3: 5b5d3ecd ($79.5 in chips)
Seat 4: 18f6db0d ($127.75 in chips)
Seat 5: d575263f ($94.21 in chips)
Seat 6: cbed3abe ($113.09 in chips)
5edaf1c2: posts small blind $0.5
5b5d3ecd: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [Kh Jh]
18f6db0d: raises $1.1 to $2.1
d575263f: folds
cbed3abe: folds
Chill: raises $4.9 to $7
5edaf1c2: folds
5b5d3ecd: folds
18f6db0d: calls $4.9
*** FLOP *** [Td 8s 4c]
18f6db0d: checks
Chill: bets $2.13
18f6db0d: calls $2.13
*** TURN *** [Td 8s 4c] [Qh]
18f6db0d: checks
Chill: bets $8.82
18f6db0d: folds
Uncalled bet ($8.82) returned to Chill
Chill collected $18.46 from pot
*** SUMMARY ***
Total pot $19.4 | Rake $0.94
Seat 1: Chill collected ($18.46)
```

**解析结果：**
- someoneRaised = true（18f6db0d 先 raise）
- Hero 第一次自愿动作 = raise → heroFacingRaise = true
- Hero raise 且 someoneRaised = true → heroThreeBet = true
- invested = 7.0 (3bet SET) → +2.13 (bet) → +8.82 → -8.82 (refund) → 9.13
- won = $18.46
- net = 18.46 - 9.13 = $9.33 / $1 = +9.33bb
- 3bet = true ✅（此手计入 numerator）

### 类型 7：ALL-IN + RUN IT TWICE + 边池

```
PokerStars Zoom Hand #4445158729: Hold'em No Limit ($0.5/$1) - 2026/04/15 22:08:17
Table 'RushAndCash2548747' 6-max Seat #1 is the button
Seat 1: 64e4afc0 ($60.69 in chips)
Seat 2: 228e9f8b ($190.56 in chips)
Seat 3: Chill ($120.63 in chips)
Seat 4: fe692a14 ($122.44 in chips)
Seat 5: c54ce006 ($102.75 in chips)
Seat 6: 31dd6405 ($101.5 in chips)
228e9f8b: posts small blind $0.5
Chill: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [Ac Ad]
fe692a14: folds
c54ce006: folds
31dd6405: folds
64e4afc0: folds
228e9f8b: raises $2 to $3
Chill: raises $7 to $10
228e9f8b: raises $15 to $25
Chill: calls $15
*** FIRST FLOP *** [Jc Ts 7s]
228e9f8b: bets $19.5
Chill: raises $76.13 to $95.63 and is all-in
228e9f8b: calls $76.13
Chill: shows [Ac Ad] (a pair of Aces)
228e9f8b: shows [Kc Kh] (a pair of Kings)
*** FIRST TURN *** [Jc Ts 7s] [4s]
*** FIRST RIVER *** [Jc Ts 7s 4s] [7h]
*** SECOND TURN *** [Jc Ts 7s] [5c]
*** SECOND RIVER *** [Jc Ts 7s 5c] [5s]
*** FIRST SHOWDOWN ***
Chill collected $118.38 from pot
*** SECOND SHOWDOWN ***
Chill collected $118.38 from pot
*** SUMMARY ***
Total pot $241.26 | Rake $4.50
Seat 3: Chill (big blind) showed [Ac Ad] and won ($118.38) with two pair, Aces and Sevens, and won ($118.38)
```

**关键——SUMMARY 行包含两个 won 金额：**
```
and won ($118.38) with two pair, Aces and Sevens, and won ($118.38)
```

**解析结果：**
- invested = 1.0 (BB SET) → 10.0 (raise SET) → 25.0 (call ADD) → 95.63 (all-in SET) = $95.63
- won = $118.38 + $118.38 = $236.76（matchAll 累加）
- net = 236.76 - 95.63 = $141.13 / $1 = +141.13bb
- showdown = true（有亮牌 + Hero 未弃牌）
- sawFlop = true（FIRST FLOP 存在）
- heroRake = min((95.63 / 245.76) × 4.50, 4.50) = $1.75

**如不累加（之前 bug）：** won = $118.38 → net = 118.38 - 95.63 = $22.75 / $1 = +22.75bb（少算 $118.38）

### 类型 8：SPLIT POT（平分底池）

```
PokerStars Zoom Hand #4444942283: Hold'em No Limit ($0.5/$1) - 2026/04/15 20:00:00
Table 'RushAndCash2535566' 6-max Seat #1 is the button
Seat 1: a39e7b11 ($100.00 in chips)
Seat 2: 4b01032f ($100.00 in chips)
Seat 3: Chill ($120.63 in chips)
Seat 4: fe692a14 ($122.44 in chips)
Seat 5: c54ce006 ($102.75 in chips)
Seat 6: 6db0dc09 ($101.5 in chips)
4b01032f: posts small blind $0.5
Chill: posts big blind $1
*** HOLE CARDS ***
Dealt to Chill [Th Ad]
fe692a14: folds
c54ce006: folds
6db0dc09: calls $1
a39e7b11: folds
4b01032f: folds
Chill: checks
*** FLOP *** [As 7d 3s]
Chill: bets $1.5
6db0dc09: calls $1.5
*** TURN *** [As 7d 3s] [Qc]
Chill: bets $3.5
6db0dc09: calls $3.5
*** RIVER *** [As 7d 3s Qc] [2h]
Chill: checks
6db0dc09: checks
*** SHOWDOWN ***
Chill: shows [Th Ad] (a pair of Aces)
6db0dc09: shows [Tc As] (a pair of Aces)
Chill collected $4.99 from pot
6db0dc09 collected $4.99 from pot
*** SUMMARY ***
Total pot $10.50 | Rake $0.52
Board [As 7d 3s Qc 2h]
Seat 3: Chill (big blind) showed [Th Ad] and collected ($4.99) with two pair, Aces and Sevens
Seat 6: 6db0dc09 showed [Tc As] and collected ($4.99) with two pair, Aces and Sevens
```

**解析结果：**
- invested = 1.0 (BB) + 1.5 + 3.5 = $6.00
- won = $4.99（SUMMARY 中 Hero 的行只有一个 collected 金额）
- net = 4.99 - 6.00 = -$1.01 / $1 = -1.01bb
- showdown = true
- 注意：Hero 平分底池但略亏损（因为抽水后分到的少于投入）

---

## 三、解析算法详解

### 3.1 切分手牌

```js
text.split(/[\r\n]+(?=Poker(?:Stars Zoom)? Hand #)/)
```

返回数组，每项一个完整手牌块。

### 3.2 投入金额 SET/ADD 规则

| 动作 | 操作 | 原因 |
|------|:--:|------|
| `posts small/big blind` | **SET** | 盲注是基础投入 |
| `raises $X to $Y` | **SET** $Y | "to" 金额 = 总投入（含之前盲注） |
| `calls $X` | **ADD** $X | 额外投入 |
| `bets $X` | **ADD** $X | 新街下注 |

**反还扣除：** `returned.*\(?\$([\d.]+)` → invested -= refund

### 3.3 摊牌判定

```js
const anyShowCards = lines.some(l => l.includes("shows [") || l.includes("showed ["));
if (anyShowCards && heroSummary && !heroSummary.includes("folded")) {
  showdown = true;
}
```

**为什么不能用 `*** SHOWDOWN ***`：** GGPoker 的**每手牌**都包含此行（即便 preflop 全弃）。

### 3.4 见翻牌判定

```js
const hasFlop = lines.some(l => l.startsWith("*** FLOP") || l.startsWith("*** FIRST FLOP"));
if (hasFlop && heroSummary && !heroSummary.includes("folded before Flop")) {
  sawFlop = true;
}
```

**Run It Twice 兼容：** 检查 `*** FLOP` 和 `*** FIRST FLOP` 两种。

### 3.5 3bet 检测

```
someoneRaised = 非Hero 玩家发出了 "raises" 动作
heroFacingRaise = Hero 首次自愿动作时 someoneRaised 已为 true
heroThreeBet = Hero 发出 "raises" 且 someoneRaised 为 true
```

**关键：** 排除 `returned` 和 `Uncalled` 行（这些行不含玩家 raise）。

### 3.6 盈亏计算

```js
// 使用 matchAll 累加所有 won/collected 金额
let heroWon = 0;
for (const wm of line.matchAll(/won\s*\(\$([\d.]+)\)/g)) {
  heroWon += parseFloat(wm[1]);
}
if (heroWon === 0) {
  for (const cm of line.matchAll(/collected\s*\(\$([\d.]+)\)/g)) {
    heroWon += parseFloat(cm[1]);
  }
}
const netUSD = heroWon - heroInvested;
const netBB = Math.round((netUSD / sb) * 100) / 100;
```

### 3.7 个人抽水

```js
const preRakePot = potTotal + rake;
const heroRake = Math.min(
  Math.round((heroInvested / preRakePot) * rake * 100) / 100,
  rake
);
```

---

## 四、统计公式汇总

| 指标 | 分子 | 分母 | 行号 |
|------|------|------|:--:|
| VPIP | 有 call/raise 动作（排除 posts 和 bets） | 总手数 | L294 |
| PFR | 有 raise 动作 | 总手数 | L303 |
| 3bet | heroThreeBet 计数 | heroFacingRaise 计数 | L330 |
| WTSD | showdown 计数 | sawFlop 计数 | L347 |
| WWSF | sawFlop 且 result>0 | sawFlop 计数 | L348 |
| W$SD | showdown 且 result>0 | showdown 计数 | L349 |
| 水后总盈利($) | Σ hand.result × parseFloat(hand.stakes.split("/")[1]) | — | L329 |
| bb/100 | (总bb / 总手数) × 100 | — | L330 |
| 桌台抽水 | Σ hand.rake | — | L258 |
| 个人抽水 | Σ hand.heroRake | — | L259 |

---

## 五、盈亏曲线（5 条线）

```js
cum      += hand.result;                                   // 水前总盈亏（绿）
cumNet   += hand.result - heroRake - heroJackpot - ...;    // 水后净盈亏（紫）
cumSD    += hand.showdown ? hand.result : 0;               // 摊牌（蓝）
cumNSD   += !hand.showdown ? hand.result : 0;              // 非摊牌（红）
// 恒等式：cum = cumSD + cumNSD

// 第 5 条：All-in EV（金色 amber #f59e0b，2026-06-26 新增）
const evBB = hand.allInEV !== null ? hand.allInEV : gameBB; // 非全押手 EV = 实际盈亏
cumEV += evBB;
```

### 5.1 All-in EV 计算口径

对齐 HM3/PT4 的 `EV $ / All-In Adj`：仅当 **Hero 全押 + 对手跟牌摊牌（双方底牌可见）** 时，该手 EV 取全押时刻按 equity 算出的期望值，否则 EV = 实际水前盈亏（无偏差点）。

```js
allInEV = (equity × potAtAllIn - heroInvested) / bb   // 水前口径，BB
```

- **纳入范围**：Hero 全押 + 对手跟牌摊牌。Hero 全押对手弃牌、Hero 未全押的手，`allInEV = null`（EV = 实际盈亏）。
- **全押时刻底池** `potAtAllIn = heroInvested + villainInvested`（双方有效投入之和）。
- **对手投入追踪**：镜像 Hero 的 SET/ADD 语义，用 `priorByPlayer`（按街道快照）+ `investedByPlayer` 双 Map，全押后街道切换不丢失。
- **equity 计算**：`computeAllInEquity()`（`src/lib/equity.ts`）——翻后（board≥3）精确枚举所有剩余 board 组合，翻前查 169×169 预计算表（`src/lib/preflop-table.ts`，`scripts/gen-preflop-table.js` 离线生成）。**纯确定性、可复现**，不用蒙特卡洛。
- **RIT**：按全押那一刻算，忽略后续 board。
- 详见设计文档 `docs/superpowers/specs/2026-06-25-ban2note-ev-curve-design.md`。

---

## 六、已知限制

| # | 限制 | 优先级 |
|:--:|------|:--:|
| 1 | PFR = 所有 raises（含翻后）→ 偏高 ~1pp | 低 |
| 2 | VPIP 排除 bets → 翻后下注不计数（正确，VPIP 是翻前指标） | — |
| 3 | `matchAll` 需要 ES2020+ 浏览器 | — |
| 4 | `*** FIRST FLOP ***` 兼容 Run It Twice，但未处理超过 2 次 Run 的极端情况 | 低 |
| 5 | 个人抽水 = 比例估算，非精确实付额 | 低 |

---

## 七、CoinPoker 格式支持（转译层）

> **代码：** `bansolver/src/lib/coinpoker.ts`（~190 行）
> **接入点：** `parseGGHandHistory()` 入口——`isCoinPokerHistory()` 识别通过后先经
> `coinpokerToGG()` 转译成 GG 同构文本，再走下方全部 GG 管线；GG 文本不经过转译，零影响。

### 设计取舍

不重写解析管线（2500 万手验证过的统计/EV/回放/分享图逻辑不动），而是在入口做
**文本 → 文本转译**。CoinPoker 与 GG 的行格式高度同构，差异只有 5 处：

| CoinPoker 原文 | 转译输出（GG） | 说明 |
|------|------|------|
| `CoinPoker Hand #123: NLH (₮0.01/₮0.02) 2026/09/19 … CST` | `Poker Hand #CP123: NLH ($0.01/$0.02) 2026/09/19 … CST` | `#CP` 前缀防跨格式 id 撞车；stakes 必须紧贴右括号（GG 头行写法，不能塞 ` USD`） |
| `₮` / `₣`（USDT/CHP 货币符号） | `$` | 纯符号替换；结果页金额对 CoinPoker 实为 USDT，数值一致 |
| `NAME: posts auto big blind $X` | `NAME: posts big blind $X` | 任意位自动补大盲 = 死盲注，GG 同功能同写法 |
| `NAME: ALLIN $X` | `bets $X all-in` / `raises $INC to $TOT all-in` / `calls $X all-in` | CoinPoker 的 ALLIN 金额 = **本次新投入增量**（实测：余注 1.85 写 1.85、余注 1.57 写 1.57），需逐行维护街内投入 + 当前注额归类成 GG 三种全押写法 |
| `NAME: RETURN $X` | `Uncalled bet ($X) returned to NAME` | 未跟注退款，GG 解析器按该行扣回投入 |

同构透传（无需处理）：Seat 行、`6-max Seat #N is the button`、`Dealt to Hero [..]`、
`folds/checks/calls/bets/raises $X to $Y`、`*** FLOP/TURN/RIVER ***`（TURN/RIVER 的
`[旧公共牌] [新牌]` 双括号与 GG 一致）、`shows [..] (牌型)`、`collected $X from pot`、
`Total pot $X | Rake $Y`、SUMMARY 的 `won ($X)` / `folded before Flop` / `didn't show`。

### 转译器内部状态

逐行状态机维护**本街投入**（`streetInv`）与**当前注额**（`currentBet`）：
blind/raises-to 为 SET（to = 本街总额），calls/bets/ALLIN 为 ADD（增量）；
`*** FLOP/TURN/RIVER ***` 处清零。退款后各玩家总投入之和恒等于 `Total pot`，
对拍脚本按此逐手验证。

### 验证基线（2026-09-27）

桌面样本 `CoinPoker_acesword_2026-09-19_to_2026-09-19_Cash.txt` 405 手（NL2 USDT，含
auto-BB 死盲、双桌交错、4-max 座位空洞、翻前/河牌全押）：
405/405 解析成功、0 重复；**独立重算 405/405 手 Hero 盈亏逐手吻合**（对拍脚本
`.tmp-check/check-coinpoker.mjs`，不经过转译器、直接按 CoinPoker 语义重算）；
GG 基准 `worker/sample-large.txt` 7213 手回归无损。

### 已知限制（CoinPoker）

| # | 限制 | 说明 |
|:--:|------|------|
| 1 | 只转译 NLH | PLO 等其他玩法整手跳过（下游评估器只支持德扑），不产错误数据 |
| 2 | ante / straddle / run-it-twice 未见样本 | 原样透传，相关投入口径可能欠账，遇到真实样本再补 |
| 3 | 玩家名不含空格 | 沿用 GG 口径（CoinPoker 导出对手是十六进制 ID、自己固定写 `Hero`，天然满足） |
| 4 | 金额单位显示 `$` | CoinPoker 实为 USDT，数值口径一致，仅符号文案差异 |

