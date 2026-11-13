export type GlyphName =
  | "ban2note"
  | "pomodoro"
  | "equity"
  | "lifesim"
  | "solver"
  | "range"
  | "train"
  | "squid"
  | "member";

export type Tool = {
  id: string;
  glyph: GlyphName;
  /** 首页卡片沿用最初的 emoji 语言 */
  emoji: string;
  title: string;
  /** 导航/搜索里的一行说明 */
  short: string;
  /** 卡片上的完整描述 */
  desc: string;
  cta: string;
  href: string;
  external?: boolean;
  tags?: string[];
  keywords: string;
};

export const SOLVER_URL = "https://zenosolver.com/?r=fmE6aFK3";

export const TOOLS: Tool[] = [
  {
    id: "ban2note",
    glyph: "ban2note",
    emoji: "📈",
    title: "数据复盘",
    short: "GG / CoinPoker 牌谱分析",
    desc: "GGPoker 牌谱拖进来：曲线、统计、去重，zip 套 zip 也吃得下。",
    cta: "分析我的牌谱",
    href: "/tools/ban2note",
    tags: ["GG · CoinPoker", "zip 套 zip", "浏览器本地解析"],
    keywords: "ban2note ggpoker coinpoker 牌谱 曲线 统计 去重 上传 pvi 盈利 数据",
  },
  {
    id: "equity",
    glyph: "equity",
    emoji: "🎯",
    title: "Equity计算器",
    short: "PokerStove 语义的胜率计算",
    desc: "PokerStove 语义：手牌精确穷举、范围 Monte Carlo，2–6 人底池。",
    cta: "算胜率",
    href: "/tools/odds",
    keywords: "equity 胜率 概率 范围 穷举 pokerstove allin 翻前",
  },
  {
    id: "preflop",
    glyph: "range",
    emoji: "🌳",
    title: "翻前范围表",
    short: "RocketSolver 翻前求解树",
    desc: "GG ZOOM GTO 翻前全树：矩阵看每手频率与 EV，牌桌重放线路，节点间自由穿梭。",
    cta: "浏览范围树",
    href: "/tools/preflop",
    keywords: "preflop 翻前 范围 gto solver 求解树 频率 ev 矩阵 rfi 开牌 3bet 4bet allin",
  },
  {
    id: "pomodoro",
    glyph: "pomodoro",
    emoji: "🍅",
    title: "扑克番茄钟",
    short: "专注块 + 强制休息，防上头",
    desc: "专注块 + 强制休息，每块记一句手感，到上限自动喊停。",
    cta: "开始专注",
    href: "/tools/pomodoro",
    keywords: "番茄钟 专注 休息 上头 tilt 时间 复盘",
  },
  {
    id: "lifesim",
    glyph: "lifesim",
    emoji: "🎮",
    title: "扑克人生模拟",
    short: "从 grinder 到 legend 的一生",
    desc: "18 项天赋、110+ 事件、15+ 结局，从 grinder 到 legend 的一生。",
    cta: "开始一生",
    href: "/tools/lifesim",
    keywords: "人生 模拟器 游戏 结局 天赋 事件 grinder legend",
  },
  {
    id: "squid",
    glyph: "squid",
    emoji: "🦑",
    title: "鱿鱼求解器",
    short: "发鱼游戏精确 EV 与结算",
    desc: "发鱼桌精确求解：每手 EV、立即结算、赢家影响矩阵，翻倍规则全支持，毫秒出数。",
    cta: "开始求解",
    href: "/tools/squid",
    keywords: "鱿鱼 发鱼 鱼 ev 求解 结算 翻倍 牌桌游戏 期望值",
  },
  {
    id: "solver",
    glyph: "solver",
    emoji: "🧮",
    title: "翻后Solver",
    short: "Zeno Solver · 外站",
    desc: "超快速 GTO 求解器：NLH & PLO，翻前免费，翻后每天可跑 10 手，Wizard 平替。",
    cta: "前往 Zeno",
    href: SOLVER_URL,
    external: true,
    keywords: "gto solver 求解 翻后 zeno wizard 平替 plo nlh",
  },
  {
    id: "pftrain",
    glyph: "train",
    emoji: "🎓",
    title: "翻前训练",
    short: "GTO 翻前决策随机出题",
    desc: "从五套 GTO 翻前解算树随机出题：按位置、对手与 3B/4B/5B 档位训练开牌决策，作答即判对错。",
    cta: "开始训练",
    href: "/tools/preflop-train",
    tags: ["GG Zoom · 红包桌 · 9MAX", "随机出题", "正确率统计"],
    keywords: "翻前 训练 出题 gto 开牌 3bet 4bet preflop drill 范围 quiz",
  },
];

/** 顶栏普通链接（金色按钮组之前的四个工具） */
const NAV_ORDER = ["equity", "pomodoro", "lifesim"];

export const NAV_TOOLS: Tool[] = NAV_ORDER.map(
  (id) => TOOLS.find((t) => t.id === id)!
);

/** 顶栏金色按钮组：与翻后Solver 同款描边、并排放在普通链接之后 */
const NAV_GOLD_ORDER = ["preflop", "ban2note"];

export const NAV_GOLD_TOOLS: Tool[] = NAV_GOLD_ORDER.map(
  (id) => TOOLS.find((t) => t.id === id)!
);

export const FEATURED_TOOL = TOOLS.find((t) => t.id === "ban2note")!;
