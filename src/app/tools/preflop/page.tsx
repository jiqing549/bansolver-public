"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import ToolHeader from "@/app/components/ToolHeader";
import SiteFooter from "@/app/components/SiteFooter";
import "./preflop.css";
import {
  type PfData,
  PIO_BRICK,
  PIO_SAGE,
  RANKS,
  actionSize,
  alphaOf,
  buildCtx,
  cellSegments,
  colorMapOf,
  colorOf,
  comboPct,
  evAt,
  fetchSolutionWithRetry,
  buildPfDiag,
  type PfFetchAttempt,
  fmtNum,
  freqAt,
  navRank,
  nextActPath,
  pathActors,
  PF_SOLUTION_URLS,
  prettyAction,
  rgba,
  sortActions,
  tableState,
} from "./trainerLogic";

/* ==============================================
   数据格式（public/preflop-tree/*.json + R2 gg-9max，scripts/export-preflop-tree.mjs 生成）
   nodes[key].a = [[动作名, 169个base36频率字符]]  频率 = parseInt(ch,36)/35
   nodes[key].e = 169*3 个 base36 字符            EV = (parseInt(s,36)-17575)/20 bb
   共用的编码 / 配色 / 牌桌推演 / 训练出题都在 trainerLogic.ts，这里只管渲染。
   ============================================== */

/* 套图清单：换/加数据源 = 丢 JSON 进 public/preflop-tree + 在这里加一行
   （URL/?v= 引 trainerLogic 的 PF_SOLUTION_URLS，唯一事实源） */
const SOLUTIONS: { id: string; short: string; brief: string; url: string }[] = [
  {
    id: "gg-zoom-3bb",
    short: "GG Zoom",
    brief: "6max · 100bb · 抽水5%上限3bb 超过30bb再抽1.5bb",
    url: PF_SOLUTION_URLS["gg-zoom-3bb"],
  },
  {
    id: "gg-zoom-2bb",
    short: "GG Zoom 2BB",
    brief: "6max · 100bb · 抽水同 GG Zoom · 开牌固定 2bb 单尺度解",
    url: PF_SOLUTION_URLS["gg-zoom-2bb"],
  },
  {
    id: "gg-zoom-2p5bb",
    short: "GG Zoom 2.5BB",
    brief: "6max · 100bb · 抽水同 GG Zoom · 开牌固定 2.5bb 单尺度解",
    url: PF_SOLUTION_URLS["gg-zoom-2p5bb"],
  },
  {
    id: "gg-10bb-hongbao",
    short: "GG 10BB红包桌",
    brief: "6max · 100bb · 红包桌：庄家每手发 10bb 红包直接入池",
    url: PF_SOLUTION_URLS["gg-10bb-hongbao"],
  },
  {
    id: "gg-9max",
    short: "GG 9MAX",
    brief: "9max · 200bb · 抽水5%上限5bb 超过30bb再抽1bb",
    url: PF_SOLUTION_URLS["gg-9max"],
  },
];

/* 6max 旧常量：套图 meta 没有 seatOrder/posname 时沿用（老 JSON 不回填） */
/* BTN 固定正下方，顺时针 BTN → SB → BB → EP → MP → CO */
const SEAT_XY: Record<number, [number, number]> = {
  0: [50, 90],
  9: [21, 70],
  8: [21, 28],
  3: [50, 9],
  2: [79, 28],
  1: [79, 70],
};
/* 9max 座位坐标（GG 9MAX · 200bb，位名与顺序走 meta.seatOrder/posname） */
const SEAT_XY_9: Record<number, [number, number]> = {
  0: [50, 92],
  9: [24, 82],
  8: [11, 58],
  6: [16, 30],
  5: [36, 10],
  4: [64, 10],
  3: [84, 30],
  2: [89, 58],
  1: [76, 82],
};

/* Pio 格式范围串：AA, AKs, KJo:0.743, ...（权重三位小数，纯手牌=100%） */
function rangeString(q: string, hands: string[]) {
  const parts: string[] = [];
  for (let i = 0; i < 169; i++) {
    const f = freqAt(q, i);
    if (f <= 1e-6) continue;
    parts.push(f >= 0.999 ? hands[i] : `${hands[i]}:${parseFloat(f.toFixed(3))}`);
  }
  return parts.join(", ");
}

/* 剪贴板：优先 async API，IAB/旧内核回退 execCommand */
async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type ViewMode = "freq" | "ev";
const VIEW_NAMES: Record<ViewMode, string> = { freq: "频率", ev: "EV" };

/* 频率取整档位：原始 → 25% → 33% → 50% → 100% 循环 */
const ROUND_LABELS = ["简化策略", "25", "33", "50", "100"];

/* 长面包屑截断：根 + 前两步 + … + 后四步 */
function crumbLabels(path: string[]): { label: string; idx: number }[] {
  const pretty = path.map(prettyAction);
  if (pretty.length <= 7) {
    return [{ label: "根节点", idx: -1 }, ...pretty.map((label, i) => ({ label, idx: i }))];
  }
  const head = pretty.slice(0, 2).map((label, i) => ({ label, idx: i }));
  const tail = pretty.slice(-4).map((label, i) => ({ label, idx: pretty.length - 4 + i }));
  return [{ label: "根节点", idx: -1 }, ...head, { label: "…", idx: pretty.length - 5 }, ...tail];
}

export default function PreflopTree() {
  const cacheRef = useRef(new Map<string, PfData>());
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastReqRef = useRef(SOLUTIONS[0].id);
  const [solId, setSolId] = useState(SOLUTIONS[0].id);
  const [data, setData] = useState<PfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* 自动重试进度（0=首次尝试中，1/2=第 n 次重试）：仅用于 loading 文案 */
  const [retryNote, setRetryNote] = useState(0);
  /* 逐次尝试遥测（诊断用）：失败后可一键复制成报告 */
  const [attempts, setAttempts] = useState<PfFetchAttempt[]>([]);
  const [diagCopied, setDiagCopied] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const [view, setView] = useState<ViewMode>("freq");
  const [filter, setFilter] = useState<string | null>(null);
  const [selHand, setSelHand] = useState<string | null>(null);
  const [roundStep, setRoundStep] = useState(0);
  const [highlightZeroEv, setHighlightZeroEv] = useState(false);
  /* 复制范围下拉（面板左上）：fixed 定位绕开 .pf-panel 的 overflow:hidden */
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyPos, setCopyPos] = useState<{ top: number; left: number } | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  /* 键盘：矩阵只保留一个 Tab 停靠点，方向键在 13×13 内移动 */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [kbIdx, setKbIdx] = useState(0);

  const applySolution = useCallback((d: PfData) => {
    setData(d);
    setPath([]);
    setFilter(null);
    setSelHand(null);
  }, []);

  const loadSolution = useCallback(
    (id: string) => {
      const sol = SOLUTIONS.find((s) => s.id === id)!;
      lastReqRef.current = id;
      // seq 统一在此推进（缓存命中同样推进）：慢树在途时切回缓存树不失效 seq，
      // 慢树落地会整体劫持已切换的视图（与训练页同源问题，2026-11-03 审查 P1）
      const my = ++seqRef.current;
      const cached = cacheRef.current.get(id);
      if (cached) {
        setSolId(id);
        applySolution(cached);
        setError(null);
        setLoading(false);
        setRetryNote(0);
        return;
      }
      setLoading(true);
      setError(null);
      setRetryNote(0);
      setAttempts([]);
      // 在途请求直接中止（放弃的 9MAX 解析对象 ~200MB+ 不再照单入库）；
      // 超时/重试策略在 fetchSolutionWithRetry：站内套 90s×3 次、R2 大树 240s×3 次
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      fetchSolutionWithRetry<PfData>(sol.url, ctrl.signal, {
        onRetry: (n) => {
          if (seqRef.current === my) setRetryNote(n);
        },
        onAttempt: (a) => {
          if (seqRef.current === my) setAttempts((prev) => [...prev, a]);
        },
      })
        .then((d: PfData) => {
          if (seqRef.current !== my) return; // 已被更新的选择作废：不缓存不应用
          if (cacheRef.current.size >= 3) {
            const oldest = cacheRef.current.keys().next().value;
            if (oldest !== undefined) cacheRef.current.delete(oldest);
          }
          cacheRef.current.set(id, d);
          setSolId(id); // 成功才前进 solId：失败时名牌/矩阵/数据保持一致
          applySolution(d);
          setLoading(false);
          setRetryNote(0);
        })
        .catch((e) => {
          if (seqRef.current !== my) return;
          setError(
            e?.name === "AbortError"
              ? "加载超时（已尝试 3 次）——当前网络到站点较慢，可更换网络或开启代理后重试"
              : String(e.message || e)
          );
          setLoading(false);
          setRetryNote(0);
        });
    },
    [applySolution]
  );

  /* 诊断报告复制：失败后一键把链路遥测发给站方（buildPfDiag 组装文本） */
  const copyDiag = useCallback(async () => {
    const sol = SOLUTIONS.find((s) => s.id === lastReqRef.current);
    const text = buildPfDiag(sol ? sol.url : "?", attempts, error ?? "(no error)");
    const ok = await copyText(text);
    setDiagCopied(ok);
    if (ok) setTimeout(() => setDiagCopied(false), 2500);
  }, [attempts, error]);

  useEffect(() => {
    loadSolution(SOLUTIONS[0].id);
    return () => abortRef.current?.abort();
  }, [loadSolution]);

  const key = path.join("/");
  const node = data ? data.nodes[key] : undefined;

  /* 桌型上下文：套图 meta 带 seatOrder/posname 用之（9max 等），否则 6max 旧常量 */
  const ctx = useMemo(() => (data ? buildCtx(data) : null), [data]);
  const seatOrder = ctx?.order ?? [];
  const posname = ctx?.posname ?? {};
  const seatXY = seatOrder.length === 9 ? SEAT_XY_9 : SEAT_XY;

  /* 没带 EV 数据的套图（如文本导出）隐藏 EV 视图 */
  const hasEv = useMemo(
    () => !!data && Object.values(data.nodes).some((n) => !!n.e),
    [data]
  );
  useEffect(() => {
    if (data && !hasEv) setView((v) => (v === "ev" ? "freq" : v));
  }, [data, hasEv]);

  /* 当前节点动作分布：组合加权占比 + 固定顺序 */
  const acts = useMemo(() => {
    if (!node?.a || !ctx) return [];
    return sortActions(
      node.a.map(([name, q]) => ({ name, q, pct: comboPct(q, ctx) }))
    );
  }, [node, ctx]);

  /* 复制范围菜单 = 非 Fold 动作，沿用频率条顺序：All-in → 加注降序 → 跟注 */
  const copyActions = useMemo(() => acts.filter((a) => a.name !== "Fold"), [acts]);

  const flashCopy = useCallback((msg: string) => {
    setCopyNote(msg);
    setCopyOpen(false);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyNote(null), 1600);
  }, []);

  const doCopyRange = useCallback(
    async (name: string) => {
      const act = node?.a?.find(([n]) => n === name);
      if (!act || !ctx) return;
      const text = rangeString(act[1], ctx.hands);
      if (!text) {
        flashCopy(`「${prettyAction(name)}」没有范围`);
        return;
      }
      flashCopy((await copyText(text)) ? `已复制 ${prettyAction(name)}` : "复制失败");
    },
    [node, ctx, flashCopy]
  );

  const openCopyMenu = useCallback(() => {
    const r = copyBtnRef.current?.getBoundingClientRect();
    if (r) setCopyPos({ top: r.bottom + 6, left: r.left });
    setCopyOpen(true);
  }, []);

  /* 外点/Esc/滚动/换节点 → 收起菜单 */
  useEffect(() => {
    if (!copyOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (copyBtnRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest(".pf-copy-menu")) return;
      setCopyOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCopyOpen(false);
    };
    const onClose = () => setCopyOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [copyOpen]);
  useEffect(() => {
    setCopyOpen(false);
  }, [key, solId]);
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    []
  );

  /* 本节点各动作的 Pio 配色：加注尺度按大小降序进砖红→红棕→深鲑鱼色阶 */
  const colorMap = useMemo(() => colorMapOf(node), [node]);

  /* 弃牌基准：node.f 由转换器从导出数据反解（弃牌 EV），EV 视图显示「相对弃牌」（弃牌=0）。
     反解不出的节点（如全员全下、无人可弃）回退绝对值 */
  const foldBase = useMemo(() => {
    if (!node?.f) return null;
    return (parseInt(node.f, 36) - 17575) / 20;
  }, [node]);

  const evMax = useMemo(() => {
    if (!node?.e) return 0;
    let m = 0.001;
    const base = foldBase ?? 0;
    for (let i = 0; i < 169; i++) m = Math.max(m, Math.abs(evAt(node.e, i) - base));
    return m;
  }, [node, foldBase]);

  const seat = useMemo(
    () => (ctx ? tableState(path, ctx) : null),
    [path, ctx]
  );
  const acting = node?.k?.length ? node.k[0][1] : null;

  const navKids = useMemo(() => {
    return [...(node?.k ?? [])].sort((a, b) => {
      const r = navRank(a[0]) - navRank(b[0]);
      if (r !== 0) return r;
      if (navRank(a[0]) === 2) return actionSize(a[0]) - actionSize(b[0]);
      return 0;
    });
  }, [node]);

  const go = (p: string[]) => {
    setPath(p);
    setFilter(null);
    setSelHand(null);
  };

  /* 点座位跳节点：没行动过的位置默认中间的人弃牌走到他；
     已行动过的位置优先 BFS 找他下一次面对行动的节点（如面对 3-bet 的干净线），
     找不到再回退到他做刚才那个动作的决策层，绝不替已行动的玩家补动作 */
  const jumpToSeat = (p: number) => {
    if (!data || !ctx) return;
    if (acting === p) return;
    const { actors, folded, allin, idx } = pathActors(path, ctx);
    const lastActed = actors.lastIndexOf(p);
    if (lastActed >= 0) {
      const next = nextActPath(data, path, p, ctx);
      if (next) {
        go(next);
        return;
      }
      const back = path.slice(0, lastActed);
      if (back.length !== path.length) go(back);
      return;
    }
    let ci = idx;
    const extra: string[] = [];
    const f2 = { ...folded };
    const a2 = { ...allin };
    let guard = 0;
    while (guard++ < seatOrder.length + 2) {
      while (f2[seatOrder[ci % seatOrder.length]] || a2[seatOrder[ci % seatOrder.length]]) ci++;
      const next = seatOrder[ci % seatOrder.length];
      if (next === p) break;
      extra.push("Fold");
      f2[next] = true;
      ci++;
    }
    const candidate = [...path, ...extra];
    if (data.nodes[candidate.join("/")]) {
      go(candidate);
      return;
    }
    /* 兜底：从根开始只折叠，直到轮到该位置 */
    const fromRoot = seatOrder.slice(0, seatOrder.indexOf(p)).map(() => "Fold");
    if (data.nodes[fromRoot.join("/")]) go(fromRoot);
  };

  /* --------------------------------------------- 渲染 */

  return (
    <>
      <Navbar />

      <section className="section pf-section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="工具台 / 范围工具"
            title="翻前范围表"
            glyph="range"
            actions={
              <Link
                href="/tools/preflop-train"
                className="tr-entry"
                title="随机出题练翻前决策，数据与本页同源"
              >
                <span className="tr-entry-dot" aria-hidden="true" />
                翻前训练
              </Link>
            }
          />

          <div className="card pf-controls">
            <div className="pf-solutions">
              {SOLUTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`pf-sol-chip${solId === s.id ? " is-active" : ""}`}
                  onClick={() => {
                    // solId 成功落地才前进（loadSolution 内部 setSolId），失败时
                    // 名牌与矩阵/数据保持一致
                    loadSolution(s.id);
                  }}
                >
                  {s.short}
                </button>
              ))}
              {loading && data && (
                <span className="pf-loading-note">
                  {retryNote > 0 ? `网络较慢，第 ${retryNote}/2 次自动重试中…` : "加载中…"}
                </span>
              )}
              {data && <span className="pf-sol-meta">{SOLUTIONS.find((s) => s.id === solId)!.brief}</span>}
              {/* 已有数据时切换失败：错误不再被 `error && !data` 吞掉，就地提示可重试 */}
              {data && error && (
                <>
                  <button type="button" className="pf-retry" onClick={() => loadSolution(lastReqRef.current)}>
                    加载失败：{error} · 点此重试
                  </button>
                  <button type="button" className="pf-retry" onClick={copyDiag}>
                    {diagCopied ? "已复制 ✓" : "复制诊断信息"}
                  </button>
                </>
              )}
            </div>
            <div className="pf-controls-right">
              <div className="pf-views" role="tablist" aria-label="矩阵视图">
                {(Object.keys(VIEW_NAMES) as ViewMode[])
                  .filter((v) => v !== "ev" || hasEv)
                  .map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    className={`pf-view-btn${view === v ? " is-active" : ""}`}
                    onClick={() => setView(v)}
                  >
                    {VIEW_NAMES[v]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!data && !error && (
            <div className="card pf-state">
              {retryNote > 0
                ? `网络较慢，第 ${retryNote}/2 次自动重试中…（单次最多 90 秒，请勿关闭页面）`
                : "加载求解数据…（首次约几 MB，稍等片刻）"}
            </div>
          )}
          {error && !data && (
            <div className="card pf-state pf-state-error">
              数据加载失败：{error}
              <button type="button" className="pf-retry" onClick={() => loadSolution(lastReqRef.current)}>
                重试
              </button>
              <button type="button" className="pf-retry" onClick={copyDiag}>
                {diagCopied ? "已复制 ✓" : "复制诊断信息"}
              </button>
            </div>
          )}

          {data && node && ctx && seat && (
            <div className="pf-layout">
              {/* ---------------- 范围矩阵（左） ---------------- */}
              <div className="pf-panel pf-grid-panel">
                <div className="pf-panel-head">
                  <button
                    ref={copyBtnRef}
                    type="button"
                    className={`pf-copy-btn${copyNote ? " is-note" : ""}${copyOpen ? " is-open" : ""}`}
                    disabled={!node.a || !copyActions.length}
                    title="复制该节点动作的范围串（Pio 格式）"
                    onClick={() => (copyOpen ? setCopyOpen(false) : openCopyMenu())}
                  >
                    {copyNote ?? "复制范围"}
                    {!copyNote && <span className="pf-copy-caret">▾</span>}
                  </button>
                  <div className="pf-head-tools">
                    <button
                      type="button"
                      className={`pf-round-btn${highlightZeroEv ? " is-on" : ""}`}
                      disabled={!node.e}
                      data-tooltip="把 EV = 0 的边缘牌格子透明度降到 55%"
                      onClick={() => setHighlightZeroEv((v) => !v)}
                    >
                      注意边缘牌
                    </button>
                    <button
                      type="button"
                      className={`pf-round-btn${roundStep > 0 ? " is-on" : ""}`}
                      disabled={view !== "freq" || !node.a}
                      data-tooltip="按档位四舍五入频率：25 / 33 / 50 / 100 / 原始"
                      onClick={() => setRoundStep((s) => (s + 1) % ROUND_LABELS.length)}
                    >
                      {ROUND_LABELS[roundStep]}
                    </button>
                  </div>
                </div>
                {copyOpen && copyPos && (
                  <div className="pf-copy-menu" style={{ top: copyPos.top, left: copyPos.left }} role="menu" aria-label="选择要复制的动作">
                    {copyActions.map((a) => (
                      <button
                        key={a.name}
                        type="button"
                        role="menuitem"
                        className="pf-copy-item"
                        onClick={() => doCopyRange(a.name)}
                      >
                        <span className="pf-copy-dot" style={{ background: rgba(colorOf(colorMap, a.name), 0.95) }} />
                        <span className="pf-copy-name">{prettyAction(a.name)}</span>
                        <span className="pf-copy-pct">{a.pct.toFixed(2)}%</span>
                      </button>
                    ))}
                  </div>
                )}
                {!node.a ? (
                  <div className="pf-nodata">
                    <p className="pf-nodata-title">
                      {node.x ? "翻前到底了" : "线路结束"}
                    </p>
                    <p className="pf-nodata-note">
                      {node.x
                        ? "这条线在翻前结束，后续翻后分支未收录"
                        : "所有对手已弃牌或已全下，无人可行动，本节点没有策略数据"}
                    </p>
                  </div>
                ) : (
                <div className="pf-gridwrap">
                  <div className="pf-gridcol">
                  <div className="pf-grid" ref={gridRef} role="group" aria-label="169 手牌范围矩阵">
                    <div className="pf-axis" />
                    {RANKS.split("").map((r) => (
                      <div key={`h-${r}`} className="pf-axis">
                        {r}
                      </div>
                    ))}
                    {RANKS.split("").map((r, ri) => (
                      <Fragment key={`row-${r}`}>
                        <div className="pf-axis">
                          {r}
                        </div>
                        {RANKS.split("").map((c, ci) => {
                          const isPair = ri === ci;
                          const hand =
                            isPair
                              ? r + r
                              : ci > ri
                                ? r + c + "s"
                                : c + r + "o";
                          const hi = ctx.hands.indexOf(hand);
                          const has = hi >= 0 && !!node.a;
                          const ev =
                            has && node.e
                              ? evAt(node.e, hi) - (foldBase ?? 0)
                              : null;
                          const zeroEv = highlightZeroEv && ev !== null && Math.abs(ev) < 1e-9;
                          /* 该手牌在本节点「不在范围 / 不选这个动作」：全部分段为 0 */
                          const shown0 = has
                            ? filter
                              ? node.a!.filter(([an]) => an === filter)
                              : node.a!
                            : [];
                          const totalF = shown0.reduce((a, [, q]) => a + freqAt(q, hi), 0);
                          const outOfRange = has && totalF <= 0.02;
                          const cell: ReactNode[] = [];

                          if (has && view === "ev" && ev !== null) {
                            const t = Math.min(1, Math.abs(ev) / evMax);
                            cell.push(
                              <span
                                key="heat"
                                style={{
                                  position: "absolute",
                                  inset: 0,
                                  /* 柔化热力：sqrt 感知曲线；0=与弃牌打平 不上色 */
                                  background: rgba(
                                    ev > 0 ? PIO_SAGE : PIO_BRICK,
                                    Math.abs(ev) <= 0.005 ? 0 : 0.07 + 0.45 * Math.sqrt(t)
                                  ),
                                }}
                              />
                            );
                          } else if (has && view === "freq") {
                            cell.push(
                              <span key="fill" className="pf-cell-fill">
                                {cellSegments(shown0, hi, roundStep).map(({ an, f }) => (
                                  <i
                                    key={an}
                                    style={{
                                      width: `${(f * 100).toFixed(2)}%`,
                                      background: rgba(colorOf(colorMap, an), alphaOf(an)),
                                    }}
                                  />
                                ))}
                              </span>
                            );
                          }

                          cell.push(
                            <span key="lbl" className="pf-cell-lbl">
                              {hand}
                            </span>
                          );

                          if (has && ev !== null && view === "ev") {
                            cell.push(
                              <span
                                key="evn"
                                className="pf-cell-evn"
                                style={{
                                  color:
                                    ev > 0.001
                                      ? "#a5cfa0"
                                      : ev < -0.001
                                        ? "#e59079"
                                        : "#d4d4d8",
                                }}
                              >
                                {(ev > 0 ? "+" : "") + ev.toFixed(1)}
                              </span>
                            );
                          }

                          return (
                            <div
                              key={hand}
                              className={`pf-cell${isPair ? " is-pair" : ""}${view === "ev" ? " is-num" : ""}${zeroEv ? " is-zero-ev" : ""}${outOfRange ? " is-out" : ""}`}
                              title={`${hand}${ev !== null ? ` · EV ${ev > 0 ? "+" : ""}${ev.toFixed(2)}` : ""}`}
                              data-hand={hand}
                              role="button"
                              tabIndex={ri * 13 + ci === kbIdx ? 0 : -1}
                              aria-label={`${hand}${ev !== null ? ` EV ${ev > 0 ? "+" : ""}${ev.toFixed(2)}` : ""}`}
                              onFocus={() => setKbIdx(ri * 13 + ci)}
                              onKeyDown={(e) => {
                                const dr =
                                  e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                                const dc =
                                  e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                                if (dr || dc) {
                                  e.preventDefault();
                                  const nr = Math.min(12, Math.max(0, ri + dr));
                                  const nc = Math.min(12, Math.max(0, ci + dc));
                                  const next =
                                    nr === nc
                                      ? RANKS[nr] + RANKS[nr]
                                      : nc > nr
                                        ? RANKS[nr] + RANKS[nc] + "s"
                                        : RANKS[nc] + RANKS[nr] + "o";
                                  gridRef.current
                                    ?.querySelector<HTMLElement>(`[data-hand="${next}"]`)
                                    ?.focus();
                                } else if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelHand(selHand === hand ? null : hand);
                                }
                              }}
                              onClick={() => setSelHand(selHand === hand ? null : hand)}
                            >
                              {cell}
                            </div>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                  <div className="pf-legend">
                    {view === "ev" ? (
                      <>
                        <span>
                          <i style={{ background: rgba(PIO_SAGE, 0.95) }} />
                          EV 正
                        </span>
                        <span>
                          <i style={{ background: rgba(PIO_BRICK, 0.95) }} />
                          EV 负
                        </span>
                        <span className="pf-legend-note">
                          {foldBase !== null ? "弃牌 = 0 · " : ""}
                          最深 = ±{evMax.toFixed(2)} {data.meta.evUnit ?? "bb"}
                        </span>
                      </>
                    ) : (
                      <>
                        {acts.map((a) => (
                          <span key={a.name}>
                            <i style={{ background: rgba(colorOf(colorMap, a.name), alphaOf(a.name)) }} />
                            {prettyAction(a.name)}
                          </span>
                        ))}
                        <span className="pf-legend-note">每格从左到右按动作频率分段</span>
                      </>
                    )}
                  </div>
                  <div className="pf-detail">
                    {selHand ? (
                      (() => {
                        const hi = ctx.hands.indexOf(selHand);
                        if (!node.a || hi < 0) return <b>{selHand}</b>;
                        return (
                          <>
                            <b>{selHand}</b>
                            {node.a.map(([an, q]) => (
                              <span key={an}>
                                {" · "}
                                <span style={{ color: rgba(colorOf(colorMap, an), 1) }}>
                                  {prettyAction(an)}
                                </span>{" "}
                                {(freqAt(q, hi) * 100).toFixed(0)}%
                              </span>
                            ))}
                            {node.e && (
                              <span className="is-gold">
                                {" · EV"}
                                {foldBase !== null ? "(相对弃牌)" : ""}{" "}
                                {(evAt(node.e, hi) - (foldBase ?? 0) > 0 ? "+" : "") +
                                  (evAt(node.e, hi) - (foldBase ?? 0)).toFixed(2)}
                              </span>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      "点一格看这手牌的具体频率与 EV"
                    )}
                  </div>
                  </div>
                </div>
                )}
              </div>

              {/* ---------------- 牌桌（右）：桌面 + 行动按钮 + 频率 ---------------- */}
              <div className="pf-panel pf-table-panel">
                <div className="pf-panel-head">
                  <span>牌桌</span>
                  <span className={`pf-panel-head-note${acting !== null ? " is-gold" : ""}`}>
                    {acting !== null
                      ? `轮到 ${posname[acting] ?? acting}`
                      : node.x
                        ? "翻后未收录"
                        : "线路结束"}
                  </span>
                </div>
                <div className="pf-tablewrap">
                  <div className="pf-felt" />
                  {seatOrder.map((p) => {
                    const mv = seat.last[p];
                    const sbPos = seatOrder[seatOrder.length - 2];
                    const bbPos = seatOrder[seatOrder.length - 1];
                    return (
                      <div
                        key={p}
                        className={`pf-seat${acting === p ? " is-acting" : ""}${seat.folded[p] ? " is-fold" : ""}`}
                        style={{ left: `${seatXY[p][0]}%`, top: `${seatXY[p][1]}%` }}
                        role="button"
                        tabIndex={0}
                        aria-label={`跳到 ${posname[p] ?? p} 的决策节点`}
                        title={`跳到 ${posname[p] ?? p} 的决策节点`}
                        onClick={() => jumpToSeat(p)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            jumpToSeat(p);
                          }
                        }}
                      >
                        <div className="pf-seat-pos">
                          {posname[p] ?? p}
                          {p === sbPos ? ` · ${fmtNum(ctx.sb)}` : p === bbPos ? ` · ${fmtNum(ctx.bb)}` : ""}
                        </div>
                        <div className="pf-seat-stk">{seat.allin[p] ? "ALL-IN" : `${fmtNum(ctx.eff[p])} bb`}</div>
                        {mv && <div className={`pf-seat-mv kind-${mv.kind}`}>{mv.label}</div>}
                      </div>
                    );
                  })}
                  <div className="pf-dealer" style={{ left: "62%", top: "78%" }}>
                    D
                  </div>
                  <div className="pf-pot">
                    <div className="pf-pot-v">{fmtNum(Math.round(seat.pot * 10) / 10)}</div>
                    <div className="pf-pot-k">POT</div>
                  </div>
                </div>

                <div className="pf-navzone">
                  <div className="pf-crumb">
                    {crumbLabels(path).map((c, i) => (
                      <button
                        key={`${c.idx}-${i}`}
                        type="button"
                        className={`pf-crumb-btn${c.idx === path.length - 1 ? " is-current" : ""}`}
                        onClick={() => go(c.idx < 0 ? [] : path.slice(0, c.idx + 1))}
                        disabled={c.label === "…"}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <div className="pf-navbtns">
                    <button
                      type="button"
                      className="pf-navbtn pf-navbtn-home"
                      aria-label="回到根节点"
                      data-tooltip="回到根节点"
                      disabled={path.length === 0}
                      onClick={() => go([])}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 11l9-8 9 8" />
                        <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="pf-navbtn pf-navbtn-home"
                      aria-label="后退一层"
                      data-tooltip="后退一层"
                      disabled={path.length === 0}
                      onClick={() => go(path.slice(0, -1))}
                    >
                      &lt;
                    </button>
                    {navKids.map(([label]) => (
                      <button
                        key={label}
                        type="button"
                        className="pf-navbtn"
                        onClick={() => go([...path, label])}
                      >
                        {prettyAction(label)}
                      </button>
                    ))}
                    {!node.k?.length && (
                      <span className="pf-navbtns-empty">
                        {node.x ? "翻前到底了 — 后续翻后分支未收录" : "这条线到底了"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="pf-acts">
                  {acts.length === 0 && (
                    <div className="pf-hint">
                      <img src="/brand/qiansuan-mark.svg" alt="" aria-hidden="true" />
                      <span>线路结束 · 没有可执行的动作</span>
                    </div>
                  )}
                  {acts.map((a) => (
                    <div
                      key={a.name}
                      className={`pf-act${filter === a.name ? " is-on" : ""}`}
                      onClick={() => {
                        // EV 视图只看每手总 EV，无法按动作筛选：点了切回频率视图
                        if (view !== "freq") setView("freq");
                        setFilter(filter === a.name ? null : a.name);
                        setSelHand(null);
                      }}
                    >
                      <span className="pf-act-nm">{prettyAction(a.name)}</span>
                      <span className="pf-act-bar">
                        <i
                          style={{
                            width: `${a.pct.toFixed(1)}%`,
                            background: rgba(colorOf(colorMap, a.name), alphaOf(a.name)),
                          }}
                        />
                      </span>
                      <span className="pf-act-pc">{a.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <SiteFooter />
    </>
  );
}
