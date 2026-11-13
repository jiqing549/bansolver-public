/* ==============================================
   翻前范围表 · 纯逻辑层（无 React / 无 DOM）
   viewer（page.tsx）与训练器（PreflopTrainer.tsx）共用，
   颜色 / 频率 / EV / 牌桌推演 / 训练出题 / EV 损失 全部只在这里定义一份。

   数据格式（public/preflop-tree/*.json + R2 gg-9max）：
   nodes[key].a = [[动作名, 169个base36频率字符]]  频率 = parseInt(ch,36)/35
   nodes[key].e = 169*3 个 base36 字符            EV = (parseInt(s,36)-17575)/20 bb
   nodes[key].f = 本节点弃牌 EV（同 e 编码）       EV 视图口径：相对弃牌 = 0
   ============================================== */

export type PfNode = {
  p: number;
  k?: [string, number][];
  x?: 1;
  a?: [string, string][];
  e?: string;
  f?: string;
};

export type PfData = {
  meta: {
    name: string;
    source: string;
    stack: number;
    sb: number;
    bb: number;
    solver: string;
    generated: string;
    nodes: number;
    strategyNodes: number;
    evUnit?: string;
    order: string[];
    /* 桌型（9max 等非 6max 套图才有；缺省按 6max 旧常量渲染） */
    seatOrder?: number[];
    posname?: Record<string, string>;
    /* 前注（GG 9MAX 0.25bb/人，R2 meta 已含；缺省 0 = 无 ante 桌） */
    ante?: number;
  };
  nodes: Record<string, PfNode>;
};

/* ---- 套图 id → 数据 URL（唯一事实源）----
   两页 SOLUTIONS 的 short/brief 各自维护（口径可不同），但 URL/?v= 只在这里改。
   ban2note 对比GTO 也引用同一份，避免三处漂移。 */
export const PF_SOLUTION_URLS: Record<string, string> = {
  "gg-zoom-3bb": "/preflop-tree/gg-zoom-3bb.json?v=3",
  "gg-zoom-2bb": "/preflop-tree/gg-zoom-2bb.json?v=2",
  "gg-zoom-2p5bb": "/preflop-tree/gg-zoom-2p5bb.json?v=1",
  "gg-10bb-hongbao": "/preflop-tree/gg-10bb-hongbao.json?v=4",
  // 165MB 细解超 Pages 25MiB 单文件限，走 R2 公开桶分发（预 gzip 传输）
  "gg-9max": "https://pub-9275dc77bd77488ab3ac0af6c0f5ddef.r2.dev/gg-9max.json?v=3",
};

/* ---- 数据拉取：超时分级 + 自动重试 + 逐次遥测 ----
   2026-11-07 用户反馈「加载超时或已中止」：部分链路直连 Cloudflare 均速 <27KB/s，
   60s 单次常超时。改为：站内套单次 90s、R2 大树（9MAX 实传 29MB）单次 240s，
   最多 3 次尝试（退避 2s/5s），慢而不死的链路靠重试挤过去。
   outer.signal = 用户切套/卸载中止：转发到每次尝试并打断退避等待。
   同日二次反馈「还是不行」→ body 改流式读取累计字节 + 每次 attempt 上报遥测
   （TTFB / 字节 / 阶段 / 错误），失败后 UI 一键复制诊断报告定位链路症状。 */
export const PF_CLIENT_VER = "pf-fetch-2026-11-07c";

export type PfFetchAttempt = {
  n: number; /* 第几次尝试（1 起） */
  ms: number; /* 总耗时 */
  ttfbMs: number | null; /* 拿到响应头耗时（没拿到 = null） */
  bytes: number; /* 已下载字节（流式累计，被掐时能看到下到哪） */
  status: number | null; /* HTTP 状态码 */
  stage: "fetch" | "headers" | "body" | "parse" | "ok";
  err: string | null; /* 错误名+消息（成功 = null） */
};

export async function fetchSolutionWithRetry<T>(
  url: string,
  outer: AbortSignal,
  opts?: { onRetry?: (attempt: number) => void; onAttempt?: (a: PfFetchAttempt) => void }
): Promise<T> {
  const perAttempt = url.startsWith("http") ? 240_000 : 90_000; // http 开头 = R2 公开桶
  const delays = [0, 2_000, 5_000];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (outer.aborted) throw new DOMException("aborted", "AbortError");
    if (delays[i] > 0) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, delays[i]);
        outer.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
      });
      if (outer.aborted) throw new DOMException("aborted", "AbortError");
    }
    /* 单次尝试独立超时控制器；outer 中止时转发，避免复用 signal 无法区分来源 */
    const tmo = new AbortController();
    const fwd = () => tmo.abort();
    outer.addEventListener("abort", fwd, { once: true });
    const timer = setTimeout(() => tmo.abort(), perAttempt);
    const t0 = performance.now();
    let ttfbMs: number | null = null;
    let bytes = 0;
    let status: number | null = null;
    const report = (stage: PfFetchAttempt["stage"], err: string | null) => {
      const a: PfFetchAttempt = { n: i + 1, ms: Math.round(performance.now() - t0), ttfbMs, bytes, status, stage, err };
      opts?.onAttempt?.(a);
      /* 控制台同步打一份：F12 现场看 */
      if (err) console.warn(`[pf-fetch] #${a.n} ${stage} ${err} bytes=${bytes} ttfb=${ttfbMs}ms ${a.ms}ms`);
      else console.info(`[pf-fetch] #${a.n} ${stage} bytes=${bytes} ttfb=${ttfbMs}ms ${a.ms}ms`);
      return a;
    };
    try {
      const r = await fetch(url, { signal: tmo.signal });
      ttfbMs = Math.round(performance.now() - t0);
      status = r.status;
      if (!r.ok) {
        report("headers", `HTTP ${r.status}`);
        throw new Error(`HTTP ${r.status}`);
      }
      /* 流式读 body：超时/被掐时 bytes 停在断点，能看出「0 字节卡死 / 下到 x% 被重置 / 稳定慢」 */
      let txt: string;
      if (r.body) {
        const reader = r.body.getReader();
        const parts: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          parts.push(value);
        }
        txt = await new Blob(parts as BlobPart[]).text();
      } else {
        txt = await r.text();
        bytes = txt.length;
      }
      const d = JSON.parse(txt) as T;
      report("ok", null);
      return d;
    } catch (e) {
      lastErr = e;
      const outerAborted = outer.aborted;
      const stage: PfFetchAttempt["stage"] = status !== null && bytes === 0 ? "headers" : bytes > 0 ? "body" : "fetch";
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (!outerAborted) report(stage, errMsg);
      /* 重试资格：本次尝试超时（非 outer 中止）/ 网络层错误 / 5xx；4xx 重试无意义 */
      const timedOut = !outerAborted && e instanceof DOMException && e.name === "AbortError";
      const netErr = e instanceof TypeError;
      const serverErr = e instanceof Error && /^HTTP 5/.test(e.message);
      if ((timedOut || netErr || serverErr) && i < delays.length - 1) {
        opts?.onRetry?.(i + 1);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", fwd);
    }
  }
  throw lastErr;
}

/* ---- 诊断报告：反馈者一键复制，粘回来即可定位 ----
   首行 PF_CLIENT_VER 用来判断他跑的是新版还是浏览器缓存的旧 chunk；
   resource timing 行（同域可用，跨域 R2 无 Timing-Allow-Origin 时为 0）给 DNS/连接/协议。 */
export function buildPfDiag(url: string, attempts: PfFetchAttempt[], errMsg: string): string {
  const L: string[] = [];
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    deviceMemory?: number;
  };
  L.push(`[pf-diag] ver=${PF_CLIENT_VER} url=${url}`);
  L.push(`[pf-diag] page=${location.pathname} t=${new Date().toISOString()}`);
  L.push(
    `[pf-diag] ua=${navigator.userAgent} lang=${navigator.language} online=${navigator.onLine}` +
      ` core=${navigator.hardwareConcurrency} mem=${nav.deviceMemory ?? "?"}G`
  );
  const c = nav.connection;
  if (c) L.push(`[pf-diag] net=effectiveType:${c.effectiveType ?? "?"} downlink:${c.downlink ?? "?"}Mbps rtt:${c.rtt ?? "?"}ms saveData:${!!c.saveData}`);
  const nav0 = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav0) L.push(`[pf-diag] nav proto=${nav0.nextHopProtocol} domContentLoaded=${Math.round(nav0.domContentLoadedEventEnd)}ms load=${Math.round(nav0.loadEventEnd)}ms`);
  for (const a of attempts) {
    const kbps = a.ms > 0 ? Math.round((a.bytes / 1024 / a.ms) * 1000) : 0;
    L.push(
      `[pf-fetch] #${a.n} ${a.stage}${a.status ? ` ${a.status}` : ""} ${a.bytes}B(${(a.bytes / 1048576).toFixed(2)}MB) ` +
        `ttfb=${a.ttfbMs === null ? "-" : a.ttfbMs + "ms"} total=${a.ms}ms ~${kbps}KB/s${a.err ? ` ERR ${a.err}` : " OK"}`
    );
  }
  const res = performance.getEntriesByName(url).pop() as PerformanceResourceTiming | undefined;
  if (res) {
    const fromCache = res.transferSize === 0 && res.decodedBodySize > 0;
    L.push(
      `[pf-res] proto=${res.nextHopProtocol || "?"} dns=${Math.round(res.domainLookupEnd - res.domainLookupStart)}ms ` +
        `connect=${Math.round(res.connectEnd - res.connectStart)}ms ttfb=${Math.round(res.responseStart - res.requestStart)}ms ` +
        `dl=${Math.round(res.responseEnd - res.responseStart)}ms transfer=${res.transferSize}B encoded=${res.encodedBodySize}B${fromCache ? " (disk-cache)" : ""}`
    );
  }
  L.push(`[pf-diag] final=${errMsg}`);
  return L.join("\n");
}

/* ---- 基础编码 ---- */
export const RANKS = "AKQJT98765432";
export const freqAt = (q: string, i: number) => parseInt(q[i], 36) / 35;
export const evAt = (e: string, i: number) =>
  (parseInt(e.slice(i * 3, i * 3 + 3), 36) - 17575) / 20;
export const combosOf = (hand: string) =>
  hand.length === 2 ? 6 : hand.endsWith("s") ? 4 : 12;
export function fmtNum(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/* ---- 动作文案与排序 ---- */
export function prettyAction(name: string) {
  if (name === "Fold") return "弃牌";
  if (name === "Call") return "跟注";
  if (name === "Check") return "过牌";
  const m = name.match(/^Raise ([\d.]+) bb$/);
  if (m) return `加注 ${m[1]} bb`;
  return name;
}
/* 频率区固定顺序：All-in → 加注 size 从大到小 → 跟注 → 弃牌 */
export function actionRank(name: string) {
  if (name === "All-in") return 0;
  if (name === "Call") return 2;
  if (name === "Fold") return 3;
  return 1;
}
export function actionSize(name: string) {
  if (name === "All-in") return Infinity;
  const m = name.match(/^Raise ([\d.]+) bb$/);
  return m ? parseFloat(m[1]) : 0;
}
export function sortActions<T extends { name: string }>(acts: T[]): T[] {
  return acts.sort(
    (x, y) =>
      actionRank(x.name) - actionRank(y.name) || actionSize(y.name) - actionSize(x.name)
  );
}
/* 节点导航 / 作答按钮顺序：弃牌 → 跟注/过牌 → 加注尺度从小到大 → All-in */
export function navRank(label: string) {
  if (label === "Fold") return 0;
  if (label === "Call" || label === "Check") return 1;
  if (label === "All-in") return 3;
  return 2;
}

/* ---- 动作配色 = PioSolver 实际方案（与主视图一致） ---- */
export const PIO_BLUE: RGB = [62, 149, 199]; /* #3e95c7 弃牌 */
export const PIO_SAGE: RGB = [119, 173, 114]; /* #77ad72 跟注 */
export const PIO_BRICK: RGB = [163, 58, 38]; /* #a33a26 主加注 */
export const PIO_COPPER: RGB = [169, 80, 65]; /* #a95041 尺度备选一 */
export const PIO_SALMON: RGB = [233, 150, 122]; /* #e9967a 尺度备选二 */
export const PIO_GOLD: RGB = [196, 164, 85]; /* #c4a455 All-in 专色 */
export const PIO_CHECK: RGB = [120, 126, 134]; /* 过牌灰 */
export type RGB = [number, number, number];
const RAISE_LADDER = [PIO_BRICK, PIO_COPPER, PIO_SALMON];
export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
/* 弃牌在深底上略压暗，其余给足饱和度 */
export const alphaOf = (name: string) => (name === "Fold" ? 0.5 : 0.95);

export function colorMapOf(node: PfNode | undefined | null): Map<string, RGB> {
  const m = new Map<string, RGB>();
  if (!node?.a) return m;
  const aggressive = node.a
    .map(([n]) => n)
    .filter((n) => n !== "Call" && n !== "Fold" && n !== "Check" && n !== "All-in")
    .sort((a, b) => actionSize(b) - actionSize(a));
  aggressive.forEach((n, i) => m.set(n, RAISE_LADDER[i % RAISE_LADDER.length]));
  if (node.a.some(([n]) => n === "All-in")) m.set("All-in", PIO_GOLD);
  return m;
}
export function colorOf(map: Map<string, RGB>, name: string): RGB {
  const hit = map.get(name);
  if (hit) return hit;
  if (name === "Fold") return PIO_BLUE;
  if (name === "Call") return PIO_SAGE;
  if (name === "Check") return PIO_CHECK;
  if (name === "All-in") return PIO_GOLD;
  return PIO_BRICK;
}

/* ---- 桌型上下文 ---- */
export type TableCtx = {
  order: number[];
  eff: Record<number, number>; // 有效筹码（扣掉已压的 ante 与盲注）
  posname: Record<number, string>;
  hands: string[];
  stack: number;
  sb: number;
  bb: number;
  ante: number;
};

const LEGACY_POSNAME: Record<number, string> = {
  3: "EP",
  2: "MP",
  1: "CO",
  0: "BTN",
  9: "SB",
  8: "BB",
};
const LEGACY_ORDER = [3, 2, 1, 0, 9, 8];

export function buildCtx(data: PfData): TableCtx {
  const m = data.meta;
  const order = (m.seatOrder?.length ? m.seatOrder : LEGACY_ORDER).map(Number);
  const sb = m.sb ?? 0.5;
  const bb = m.bb ?? 1;
  const stack = m.stack ?? 100;
  const ante = m.ante ?? 0;
  const sbSeat = order[order.length - 2];
  const bbSeat = order[order.length - 1];
  const eff: Record<number, number> = {};
  for (const p of order) {
    // 每座都已压 ante（9MAX 0.25bb/人），盲注座再扣对应盲注——此前 ante 全链路
    // 被忽略，非盲注座位筹码虚显 200、根池虚显 1.5（真实 3.75bb）
    const base = stack - ante;
    eff[p] = p === bbSeat ? base - bb : p === sbSeat ? base - sb : base;
  }
  const posname: Record<number, string> = m.posname
    ? (Object.fromEntries(
        Object.entries(m.posname).map(([k, v]) => [Number(k), v])
      ) as Record<number, string>)
    : LEGACY_POSNAME;
  return { order, eff, posname, hands: m.order ?? [], stack, sb, bb, ante };
}

/* ---- 牌桌推演：沿路径重放每一步（含盲注底池 + Check 正确标注） ---- */
export type SeatMove = {
  label: string;
  kind: "fold" | "call" | "raise" | "allin" | "check";
};
export type TableStateT = {
  pot: number;
  maxBet: number;
  folded: Record<number, boolean>;
  allin: Record<number, boolean>;
  last: Record<number, SeatMove>;
  contrib: Record<number, number>;
};

export function tableState(path: string[], ctx: TableCtx): TableStateT {
  const { order, eff, sb, bb, ante } = ctx;
  /* contrib 语义与旧版一致 = 面向 maxBet 的行动金额（solver 的 raise-to 口径，
     不含 ante）：PreflopTrainer 的 toCall（maxBet - contrib）与筹码显示都拿它
     做游戏计算，混入 ante 会让每座差 0.25bb。ante 只进 pot 总额：
     pot = Σcontrib + ante×人数（弃牌座的 ante 已付，同样在池里） */
  const contrib: Record<number, number> = {};
  for (const p of order) contrib[p] = 0;
  /* 盲注直接入池：根节点 POT = ante×人数 + 1.5bb（无 ante 桌仍 1.5bb），
     与训练桌同一口径 */
  contrib[order[order.length - 2]] = sb;
  contrib[order[order.length - 1]] = bb;
  const folded: Record<number, boolean> = {};
  const allin: Record<number, boolean> = {};
  const last: Record<number, SeatMove> = {};
  let maxBet = bb;
  let idx = 0;
  for (const seg of path) {
    let guard = 0;
    while (
      guard++ < order.length + 2 &&
      (folded[order[idx % order.length]] || allin[order[idx % order.length]])
    )
      idx++;
    const p = order[idx % order.length];
    idx++;
    if (seg === "Fold") {
      folded[p] = true;
      last[p] = { label: "弃牌", kind: "fold" };
    } else if (seg === "Call") {
      contrib[p] = Math.max(contrib[p], maxBet);
      if (contrib[p] >= eff[p]) {
        allin[p] = true;
        last[p] = { label: "All-in", kind: "allin" };
      } else last[p] = { label: `跟注 ${fmtNum(maxBet)}`, kind: "call" };
    } else if (seg === "All-in") {
      contrib[p] = Math.max(contrib[p], eff[p]);
      maxBet = Math.max(maxBet, contrib[p]);
      allin[p] = true;
      last[p] = { label: "All-in", kind: "allin" };
    } else if (seg === "Check") {
      /* 过牌不改变底池与最大注，之前会掉进 else 分支被误标成「跟注」 */
      last[p] = { label: "过牌", kind: "check" };
    } else {
      const m = seg.match(/^Raise ([\d.]+) bb$/);
      const v = m ? parseFloat(m[1]) : maxBet;
      const isRaise = v > maxBet;
      if (isRaise) maxBet = v;
      contrib[p] = Math.max(contrib[p], v);
      if (v >= eff[p]) {
        allin[p] = true;
        last[p] = { label: "All-in", kind: "allin" };
      } else {
        last[p] = {
          label: `${isRaise ? "加注" : "跟注"} ${fmtNum(v)}`,
          kind: isRaise ? "raise" : "call",
        };
      }
    }
  }
  const pot =
    Object.values(contrib).reduce((a, b) => a + b, 0) + ante * order.length;
  return { pot, maxBet, folded, allin, last, contrib };
}

/* 组合加权占比（与 solver 面板 % 一致） */
export function comboPct(q: string, ctx: TableCtx) {
  let s = 0;
  for (let i = 0; i < 169; i++) s += freqAt(q, i) * combosOf(ctx.hands[i]);
  return (s / 1326) * 100;
}

/* 本节点各动作整体占比（归一化，训练图例/对手范围标题用） */
export function aggPcts(node: PfNode, ctx: TableCtx) {
  const out = (node.a ?? []).map(([name, q]) => ({
    name,
    p: comboPct(q, ctx) / 100,
  }));
  const tot = out.reduce((a, b) => a + b.p, 0);
  if (tot > 0) out.forEach((o) => (o.p = o.p / tot));
  return out;
}

/* 频率取整档位：原始 → 25% → 33% → 50% → 100% 循环。
   单格分段取整：最大余数法，保持各段之和不丢（逐段独立取整会把整格舍成 0，格子发黑）。
   目标份数不带最小 1 份兜底：右栏动作筛选（单动作分段）时，小频率手牌按四舍五入
   落 0 份就该整格消失——此前 Math.max(1,…) 把 2% 的小频率也顶成 50% 填充，范围画错 */
export function cellSegments(
  items: [string, string][],
  hi: number,
  step: number
): { an: string; f: number }[] {
  const raw = items.map(([an, q]) => ({ an, f: freqAt(q, hi) }));
  const total = raw.reduce((a, s) => a + s.f, 0);
  if (step === 0) return raw.filter((s) => s.f > 0.03);
  if (total <= 0.02) return [];
  const qn = step === 1 ? 4 : step === 2 ? 3 : step === 3 ? 2 : 1;
  const scaled = raw.map((s) => ({ ...s, x: s.f * qn }));
  const units = scaled.map((s) => Math.round(s.x));
  const target = Math.round(total * qn);
  let diff = target - units.reduce((a, b) => a + b, 0);
  const byRemainder = scaled.map((s, i) => i).sort((i, j) => scaled[j].x - units[j] - (scaled[i].x - units[i]));
  let k = 0;
  while (diff !== 0 && k < byRemainder.length * 4) {
    const i = byRemainder[k % byRemainder.length];
    if (diff > 0) {
      units[i] += 1;
      diff -= 1;
    } else if (units[i] > 0) {
      units[i] -= 1;
      diff += 1;
    }
    k += 1;
  }
  return raw
    .map((s, i) => ({ an: s.an, f: units[i] / qn }))
    .filter((s) => s.f > 1e-9);
}

/* 沿路径推演每个动作对应的座位（点座位跳节点 / 出题都靠它） */
export function pathActors(path: string[], ctx: TableCtx) {
  const { order } = ctx;
  const folded: Record<number, boolean> = {};
  const allin: Record<number, boolean> = {};
  const actors: number[] = [];
  let idx = 0;
  for (const seg of path) {
    let guard = 0;
    while (
      guard++ < order.length + 2 &&
      (folded[order[idx % order.length]] || allin[order[idx % order.length]])
    )
      idx++;
    const p = order[idx % order.length];
    idx++;
    actors.push(p);
    if (seg === "Fold") folded[p] = true;
    else if (seg === "All-in") allin[p] = true;
  }
  return { actors, folded, allin, idx };
}

/* ---- 下注扫描：加注计数 + 主动入池标记（冷 call 判定） ---- */
export function betScan(path: string[], ctx: TableCtx) {
  const { actors } = pathActors(path, ctx);
  let cur = ctx.bb;
  let raises = 0;
  const invested: Record<number, boolean> = {};
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const s = actors[i];
    if (a === "Fold") continue;
    if (a === "Call" || a === "Check") {
      invested[s] = true;
      continue;
    }
    const m = a.match(/^Raise ([\d.]+) bb$/);
    const size = m
      ? parseFloat(m[1])
      : ctx.eff[s] != null
        ? ctx.eff[s]
        : ctx.stack;
    if (size > cur) raises += 1;
    cur = Math.max(cur, size);
    invested[s] = true;
  }
  return { raises, invested };
}
/* 冷 call：面对 ≥3B 且自己此前未主动入池（盲注强制投入不算） */
export function isColdCall(path: string[], seat: number, ctx: TableCtx) {
  const scan = betScan(path, ctx);
  return scan.raises >= 2 && !scan.invested[seat];
}
/* 路径里第 n 次加注（1 起，口径同 betScan：超当前注才算）是谁做的；不足 n 次返回 null。
   4B/5B 档位语义用：4B=第 1 注（开注）是 Hero，5B=第 2 注（3bet）是 Hero */
export function raiseActor(path: string[], n: number, ctx: TableCtx): number | null {
  const { actors } = pathActors(path, ctx);
  let cur = ctx.bb;
  let k = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    if (a === "Fold" || a === "Call" || a === "Check") continue;
    const m = a.match(/^Raise ([\d.]+) bb$/);
    const size = m
      ? parseFloat(m[1])
      : ctx.eff[actors[i]] != null
        ? ctx.eff[actors[i]]
        : ctx.stack;
    if (size > cur) {
      k += 1;
      if (k === n) return actors[i];
    }
    cur = Math.max(cur, size);
  }
  return null;
}
/* 路径里任何人冷 call → 这条线不进训练 */
export function pathHasColdCall(path: string[], ctx: TableCtx) {
  const { actors } = pathActors(path, ctx);
  let cur = ctx.bb;
  let raises = 0;
  const invested: Record<number, boolean> = {};
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const s = actors[i];
    if (a === "Fold") continue;
    if (a === "Call" || a === "Check") {
      if (a === "Call" && raises >= 2 && !invested[s]) return true;
      invested[s] = true;
      continue;
    }
    const m = a.match(/^Raise ([\d.]+) bb$/);
    const size = m
      ? parseFloat(m[1])
      : ctx.eff[s] != null
        ? ctx.eff[s]
        : ctx.stack;
    if (size > cur) raises += 1;
    cur = Math.max(cur, size);
    invested[s] = true;
  }
  return false;
}

/* 入池人数 = 已行动且未弃牌者 + Hero（还没轮到的不算） */
export function potSize(path: string[], heroSeat: number, ctx: TableCtx) {
  const { actors } = pathActors(path, ctx);
  const live: Record<number, boolean> = {};
  for (let i = 0; i < path.length; i++) {
    const s = actors[i];
    if (s === heroSeat) continue;
    live[s] = path[i] !== "Fold";
  }
  let n = 1;
  for (const k in live) if (live[k]) n += 1;
  return n;
}

/* 训练池：封顶两人；三人池只放 squeeze 决策节点
   （有人开注 + 恰好一人跟注 + 轮到 Hero，下一档 3B = 挤压/跟/弃全套选项）。
   三人池的冷 4B / 面对挤压 / 面对 4B 等非 squeeze 局面不进训练。 */
export function spotPoolOk(path: string[], seat: number, ctx: TableCtx) {
  const ps = potSize(path, seat, ctx);
  if (ps <= 2) return true;
  return ps === 3 && betScan(path, ctx).raises === 1;
}

/* ---- 行动线可见性：与矩阵 freq 视图同一 3% 阈值 ----
   原始视图里某手牌某动作频率 ≤3% 就不显示，所以一个动作若没有任何一手牌
   能在图上看到，就不允许出现在题目路径里（抽样权重也只统计可见部分）。 */
const VISIBLE = 0.03;
export type LineAgg = { name: string; w: number; p: number }[] | null;
export type LineCache = Map<string, LineAgg>;
export const makeLineCache = (): LineCache => new Map();

export function lineAgg(
  data: PfData,
  key: string,
  ctx: TableCtx,
  cache: LineCache
): LineAgg {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const n = data.nodes[key];
  let out: LineAgg = null;
  if (n?.a?.length) {
    const w = n.a.map(() => 0);
    for (let i = 0; i < 169; i++) {
      const cw = combosOf(ctx.hands[i]);
      for (let j = 0; j < n.a.length; j++) {
        const f = freqAt(n.a[j][1], i);
        if (f > VISIBLE) w[j] += f * cw;
      }
    }
    const tot = w.reduce((a, b) => a + b, 0);
    out = n.a.map(([name], j) => ({ name, w: w[j], p: tot > 0 ? w[j] / tot : 0 }));
  }
  cache.set(key, out);
  return out;
}

/* 路径上每一步都必须在图上可见（加权组合数 > 0） */
export function pathVisible(
  key: string,
  ctx: TableCtx,
  data: PfData,
  cache: LineCache
) {
  const parts = key ? key.split("/") : [];
  let pre = "";
  for (const part of parts) {
    const agg = lineAgg(data, pre, ctx, cache);
    if (!agg) return false;
    const hit = agg.find((x) => x.name === part);
    if (!hit || hit.w <= 0) return false;
    pre = pre ? pre + "/" + part : part;
  }
  return true;
}

/* 随机走一条真实存在的行动线：动作按可见权重抽样，Hero 遇到冷 call 局面时屏蔽跟注 */
export function walkLine(data: PfData, ctx: TableCtx, cache: LineCache): string {
  let key = "";
  let node = data.nodes[""];
  let depth = 0;
  while (node?.k?.length && depth < 8) {
    if (depth >= 1 && node.a && node.a.length >= 2 && Math.random() < 0.42) break;
    if (!node.a || node.a.length < 2) break;
    const agg = lineAgg(data, key, ctx, cache);
    if (!agg) break;
    let live = agg.filter((x) => x.w > 0);
    const actor = Number(node.k[0][1]);
    if (isColdCall(key ? key.split("/") : [], actor, ctx))
      live = live.filter((x) => x.name !== "Call");
    if (!live.length) break;
    const r = Math.random();
    let acc = 0;
    let pick = live[live.length - 1].name;
    for (let i = 0; i < live.length; i++) {
      acc += live[i].p;
      if (r <= acc) {
        pick = live[i].name;
        break;
      }
    }
    const nk = key ? key + "/" + pick : pick;
    if (!data.nodes[nk]) break;
    key = nk;
    node = data.nodes[nk];
    depth++;
  }
  return key;
}

/* ---- 行动线里某座位自己做过的动作（Hero 发牌约束 / 对手摊牌加权共用） ---- */
export function lineMovesOf(data: PfData, path: string[], seat: number, ctx: TableCtx) {
  const { actors } = pathActors(path, ctx);
  let pre = "";
  const out: { node: PfNode; act: string }[] = [];
  for (let i = 0; i < path.length; i++) {
    const n = data.nodes[pre];
    if (n?.a && actors[i] === seat) out.push({ node: n, act: path[i] });
    pre = pre ? pre + "/" + path[i] : path[i];
  }
  return out;
}

function actFreqOf(node: PfNode, act: string, i: number) {
  const it = node.a?.find(([n]) => n === act);
  return it ? freqAt(it[1], i) : 0;
}

/* Hero 发牌：首次行动按全范围；之后沿行动线自己最近一次动作的范围发
   （每个历史动作对该手牌 freq>3% 才成立，不会出现「拿 99 却冷 4B」的自己） */
export function dealHero(
  data: PfData,
  node: PfNode,
  path: string[],
  seat: number,
  ctx: TableCtx
): number {
  if (!node?.a) return dealAnyHand(ctx);
  const moves = lineMovesOf(data, path, seat, ctx);
  const w: number[] = [];
  let tot = 0;
  for (let i = 0; i < 169; i++) {
    let ok = true;
    let x = 1;
    for (let j = 0; j < moves.length; j++) {
      const f = actFreqOf(moves[j].node, moves[j].act, i);
      if (f <= VISIBLE) {
        ok = false;
        break;
      }
      if (j === moves.length - 1) x = f;
    }
    if (!ok) {
      w[i] = 0;
      continue;
    }
    w[i] = x * combosOf(ctx.hands[i]);
    tot += w[i];
  }
  if (tot <= 0) return -1;
  return weightedPick(w, tot);
}

function dealAnyHand(ctx: TableCtx): number {
  const w = ctx.hands.map((h) => combosOf(h));
  return weightedPick(w, w.reduce((a, b) => a + b, 0));
}

function weightedPick(w: number[], tot: number): number {
  if (tot <= 0) return -1;
  const r = Math.random() * tot;
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i];
    if (r <= acc) return i;
  }
  return w.length - 1;
}

/* ---- 对手摊牌：按他在该动作上的频率加权抽一手（不是真实底牌） ---- */
export const SUITS = ["♠", "♥", "♦", "♣"];
export type Card = { r: string; s: string };

function villainHandIdx(data: PfData, seat: number, path: string[], ctx: TableCtx) {
  const moves = lineMovesOf(data, path, seat, ctx);
  const w: number[] = [];
  let tot = 0;
  for (let i = 0; i < 169; i++) {
    let p = 1;
    let ok = true;
    for (let j = 0; j < moves.length; j++) {
      const f = actFreqOf(moves[j].node, moves[j].act, i);
      if (f <= VISIBLE) {
        ok = false;
        break;
      }
      p *= f;
    }
    if (!ok || p <= 0) {
      w[i] = 0;
      continue;
    }
    w[i] = p * combosOf(ctx.hands[i]);
    tot += w[i];
  }
  return tot > 0 ? weightedPick(w, tot) : -1;
}

/* 一手 169 记号牌 → 两张具体花色（从剩余牌堆里抽，s=同花 p=对子/o=不同花） */
function drawSuit(hand: string, deck: string[]): [Card, Card] | null {
  const r1 = hand[0];
  const r2 = hand[1];
  const kind = hand.length === 3 ? hand[2] : "p";
  const cand: [number, number][] = [];
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++) {
      if (kind === "s" ? a !== b : a === b) continue;
      if (deck.indexOf(r1 + SUITS[a]) < 0 || deck.indexOf(r2 + SUITS[b]) < 0) continue;
      cand.push([a, b]);
    }
  if (!cand.length) return null;
  const [a, b] = cand[Math.floor(Math.random() * cand.length)];
  return [
    { r: r1, s: SUITS[a] },
    { r: r2, s: SUITS[b] },
  ];
}

export type Spot = {
  key: string;
  path: string[];
  node: PfNode;
  seat: number;
  hi: number;
  hand: string;
  cards: [Card, Card];
  vhands: Record<number, [Card, Card]>;
};

/* 摊牌：只发在这条线里真做过动作且未弃牌的对手，同一副 52 张牌不撞车 */
function dealVillains(data: PfData, key: string, path: string[], seat: number, hi: number, ctx: TableCtx) {
  const tb = tableState(path, ctx);
  const deck: string[] = [];
  for (let x = 0; x < 13; x++) for (let y = 0; y < 4; y++) deck.push(RANKS[x] + SUITS[y]);
  const heroHand = ctx.hands[hi];
  const kind = heroHand.length === 3 ? heroHand[2] : "p";
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++) {
      if (kind === "s" ? a !== b : a === b) continue;
      const i1 = deck.indexOf(heroHand[0] + SUITS[a]);
      const i2 = deck.indexOf(heroHand[1] + SUITS[b]);
      if (i1 < 0 || i2 < 0) continue;
      deck.splice(Math.max(i1, i2), 1);
      deck.splice(Math.min(i1, i2), 1);
      break;
    }
  const out: Record<number, [Card, Card]> = {};
  for (const p of ctx.order) {
    if (p === seat || tb.folded[p] || !tb.last[p]) continue;
    const vhi = villainHandIdx(data, p, path, ctx);
    if (vhi < 0) continue;
    const cs = drawSuit(ctx.hands[vhi], deck);
    if (!cs) continue;
    deck.splice(deck.indexOf(cs[0].r + cs[0].s), 1);
    deck.splice(deck.indexOf(cs[1].r + cs[1].s), 1);
    out[p] = cs;
  }
  return out;
}

/* Hero 底牌花色随机（对子/不同花，同花同花色） */
export function heroCards(hand: string): [Card, Card] {
  const r1 = hand[0];
  const r2 = hand[1];
  const kind = hand.length === 3 ? hand[2] : "p";
  const s1 = Math.floor(Math.random() * 4);
  const s2 = kind === "s" ? s1 : (s1 + 1 + Math.floor(Math.random() * 3)) % 4;
  return [
    { r: r1, s: SUITS[s1] },
    { r: r2, s: SUITS[s2] },
  ];
}

/* ---- 训练出题 ---- */
export type TrainerFilters = {
  heroSeat: number | null;
  villainSeat: number | null;
  heroAction: number | null; // 2 / 3 / 4 / 5（Hero 的下一档加注，2=RFI 开局），null = 任意
};
export type CandidateCache = Map<string, string[]>;

export function filtersKey(f: TrainerFilters) {
  return `${f.heroSeat}|${f.villainSeat}|${f.heroAction}`;
}

/* 行动线上最后一个非弃牌动作 = Hero 要面对的那位 */
export function lastAggressor(data: PfData, key: string) {
  const parts = key ? key.split("/") : [];
  let pre = "";
  let v: { seat: number; act: string; node: PfNode; key: string } | null = null;
  for (const part of parts) {
    const n = data.nodes[pre];
    if (!n?.k?.length) break;
    if (part !== "Fold") v = { seat: Number(n.k[0][1]), act: part, node: n, key: pre };
    pre = pre ? pre + "/" + part : part;
  }
  return v;
}

function spotOk(
  key: string,
  node: PfNode | undefined,
  ctx: TableCtx,
  data: PfData,
  cache: LineCache,
  f: TrainerFilters
) {
  if (!node?.a || node.a.length < 2 || !node.k?.length) return false;
  const parts = key ? key.split("/") : [];
  const seat = Number(node.k[0][1]);
  if (!pathVisible(key, ctx, data, cache)) return false;
  if (!spotPoolOk(parts, seat, ctx)) return false;
  if (pathHasColdCall(parts, ctx)) return false;
  /* Hero 若只能冷 call 3B，屏蔽跟注后至少还要剩两个可选动作，否则没有训练意义 */
  if (
    isColdCall(parts, seat, ctx) &&
    node.a.filter((it) => it[0] !== "Call").length < 2
  )
    return false;
  if (f.heroSeat !== null && seat !== f.heroSeat) return false;
  if (f.villainSeat !== null) {
    const v = lastAggressor(data, key);
    if (!v || v.seat !== f.villainSeat) return false;
  }
  /* 首次加注是 2B；已加 0 / 1 / 2 / 3 次时 Hero 的下一档分别是 RFI / 3B / 4B / 5B */
  if (f.heroAction !== null && betScan(parts, ctx).raises + 2 !== f.heroAction)
    return false;
  /* 4B/5B 档位语义（2026-11-13 拍板）：4B=自己开注被 3bet、5B=自己 3bet 被 4bet。
     冷 call 者面对挤压（raises=2）或面对 4bet（raises=3）的局面不算——
     potSize 不计 Hero，这类三人线 ps=2 会漏进来，这里按加注者身份拦掉 */
  if (f.heroAction === 4 && raiseActor(parts, 1, ctx) !== seat) return false;
  if (f.heroAction === 5 && raiseActor(parts, 2, ctx) !== seat) return false;
  return true;
}

export function makeSpot(
  data: PfData,
  ctx: TableCtx,
  cache: LineCache,
  candCache: CandidateCache,
  f: TrainerFilters
): { key: string; node: PfNode; hi: number } | null {
  /* 1) 随机走 140 次，绝大多数场景直接命中 */
  for (let tries = 0; tries < 140; tries++) {
    const key = walkLine(data, ctx, cache);
    const node = data.nodes[key];
    if (!spotOk(key, node, ctx, data, cache, f)) continue;
    if (!node.a || !node.k?.length) continue;
    const hi = dealHero(data, node, key ? key.split("/") : [], Number(node.k[0][1]), ctx);
    if (hi < 0) continue;
    return { key, node, hi };
  }
  const hasFilter =
    f.heroSeat !== null || f.villainSeat !== null || f.heroAction !== null;
  /* 2) 无筛选还找不到（极罕见）：顺序兜底，绝不退回不合法局面 */
  if (!hasFilter) {
    for (const k of Object.keys(data.nodes)) {
      const node = data.nodes[k];
      if (
        !node?.a ||
        node.a.length < 2 ||
        !node.k?.length ||
        !pathVisible(k, ctx, data, cache) ||
        !spotPoolOk(k ? k.split("/") : [], Number(node.k[0][1]), ctx) ||
        pathHasColdCall(k ? k.split("/") : [], ctx)
      )
        continue;
      const hi = dealHero(data, node, k ? k.split("/") : [], Number(node.k[0][1]), ctx);
      if (hi >= 0) return { key: k, node, hi };
    }
    return null;
  }
  /* 3) 带筛选：候选列表按 (套图+筛选) 缓存，只全树扫一次，之后随机起点线性挑 */
  const ck = filtersKey(f);
  let cand = candCache.get(ck);
  if (!cand) {
    cand = Object.keys(data.nodes).filter((k) =>
      spotOk(k, data.nodes[k], ctx, data, cache, f)
    );
    candCache.set(ck, cand);
  }
  const start = Math.floor(Math.random() * cand.length);
  for (let i = 0; i < cand.length; i++) {
    const k = cand[(start + i) % cand.length];
    const node = data.nodes[k];
    if (!node?.a || !node.k?.length) continue;
    const hi = dealHero(data, node, k ? k.split("/") : [], Number(node.k[0][1]), ctx);
    if (hi >= 0) return { key: k, node, hi };
  }
  return null;
}

export function assembleSpot(
  data: PfData,
  ctx: TableCtx,
  found: { key: string; node: PfNode; hi: number }
): Spot {
  const path = found.key ? found.key.split("/") : [];
  const seat = Number(found.node.k![0][1]);
  return {
    key: found.key,
    path,
    node: found.node,
    seat,
    hi: found.hi,
    hand: ctx.hands[found.hi],
    cards: heroCards(ctx.hands[found.hi]),
    vhands: dealVillains(data, found.key, path, seat, found.hi, ctx),
  };
}

/* ---- 作答评分 ----
   判定（策略契合）：所选动作频率 ≥45% 或为该手最高频 → 对；≥15% → 半对；否则错。
   不做 EV 损失统计：数据只有每手综合 EV（弃牌=0 基准），算不出分动作损失，
   估算值大面积为 0 没有信息量（2026-11-02 用户拍板删除）。 */
export type Answer = {
  f: number;
  bestName: string;
  bestF: number;
  verdict: "ok" | "half" | "bad";
};

export function scoreAnswer(node: PfNode, hi: number, action: string): Answer {
  const acts = (node.a ?? []).map(([name, q]) => ({ name, f: freqAt(q, hi) }));
  const picked = acts.find((x) => x.name === action) ?? { name: action, f: 0 };
  let best = acts[0] ?? { name: "", f: 0 };
  for (const x of acts) if (x.f > best.f) best = x;
  const verdict: Answer["verdict"] =
    picked.f >= 0.45 || picked.f >= best.f - 1e-9
      ? "ok"
      : picked.f >= 0.15
        ? "half"
        : "bad";
  return { f: picked.f, bestName: best.name, bestF: best.f, verdict };
}

/* 该手在当前节点的综合 EV（相对弃牌 = 0），没有 e 字段返回 null */
export function handEvOf(node: PfNode, hi: number): number | null {
  if (!node.e) return null;
  const foldBase = node.f ? (parseInt(node.f, 36) - 17575) / 20 : 0;
  return evAt(node.e, hi) - foldBase;
}

/* ---- 点座位跳节点：已行动过的座位优先跳他下一次面对行动的节点 ----
   BFS 层级最浅优先，同层按弃牌→跟注→加注→全下排序，落点通常是
   「只面对一次加注」的干净线路；绝不替已行动的玩家补第二个动作。 */
export function nextActPath(
  data: PfData,
  fromPath: string[],
  target: number,
  ctx: TableCtx
): string[] | null {
  const key = fromPath.join("/");
  const root = data.nodes[key];
  if (!root?.k?.length) return null;
  const calm = (k: [string, number][]) =>
    k
      .slice()
      .sort((x, y) => {
        const d = navRank(x[0]) - navRank(y[0]);
        return d !== 0 ? d : navRank(x[0]) === 2 ? actionSize(x[0]) - actionSize(y[0]) : 0;
      });
  if (pathActors(fromPath, ctx).actors.indexOf(Number(root.k[0][1])) >= 0) return null;
  const q: { p: string[]; d: number }[] = [];
  for (const a of calm(root.k)) q.push({ p: [...fromPath, a[0]], d: 1 });
  let head = 0;
  let seen = 0;
  while (head < q.length && seen < 40000) {
    const cur = q[head];
    head++;
    seen++;
    const node = data.nodes[cur.p.join("/")];
    if (!node?.k?.length) continue;
    if (Number(node.k[0][1]) === target) return cur.p;
    if (cur.d >= 12) continue;
    if (pathActors(cur.p, ctx).actors.indexOf(Number(node.k[0][1])) >= 0) continue;
    for (const a of calm(node.k)) q.push({ p: [...cur.p, a[0]], d: cur.d + 1 });
  }
  return null;
}

/* ---- 训练桌座位定位：stadium（两端半圆跑道形）周长取点，从上中点顺时针 ---- */
export function stadiumPoint(frac: number, A: number, R: number): [number, number] {
  const L = 4 * A + 2 * Math.PI * R;
  let d = (((frac % 1) + 1) % 1) * L;
  if (d < A) return [d, -R];
  d -= A;
  if (d < Math.PI * R) {
    const a = -Math.PI / 2 + d / R;
    return [A + R * Math.cos(a), R * Math.sin(a)];
  }
  d -= Math.PI * R;
  if (d < 2 * A) return [A - d, R];
  d -= 2 * A;
  if (d < Math.PI * R) {
    const a = Math.PI / 2 + d / R;
    return [-A + R * Math.cos(a), R * Math.sin(a)];
  }
  d -= Math.PI * R;
  return [-A + d, -R];
}

/* 简化档位（与主视图共享）：原始 → 25 → 33 → 50 → 100 */
export const SIMP_LABELS = ["原始", "25%", "33%", "50%", "100%"];
