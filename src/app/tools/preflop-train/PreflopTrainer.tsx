"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type PfData,
  type PfNode,
  type TableCtx,
  type TableStateT,
  type Spot,
  type TrainerFilters,
  type Card,
  RANKS,
  aggPcts,
  alphaOf,
  assembleSpot,
  betScan,
  buildCtx,
  cellSegments,
  colorMapOf,
  colorOf,
  fmtNum,
  freqAt,
  handEvOf,
  isColdCall,
  lastAggressor,
  makeLineCache,
  makeSpot,
  navRank,
  pathActors,
  prettyAction,
  rgba,
  scoreAnswer,
  actionSize,
  SIMP_LABELS,
  stadiumPoint,
  tableState,
  type CandidateCache,
} from "../preflop/trainerLogic";

/* ==============================================
   翻前训练：从当前解算树随机出题，练翻前决策。
   出题只在范围表上真实存在的行动线里游走（动作对至少一手牌 freq>3%），
   入池封顶两人；三人池仅限 squeeze 决策节点（开注+一人跟注+轮到 Hero 的 3B），
   路径与 Hero 可选动作都禁止冷 call 3B。
   「你的行动」档位：RFI=无人加注的开局；3B=面对一注；4B=自己开注被 3bet；
   5B=自己 3bet 被 4bet（冷 call 者面对挤压/4bet 的局面不进 4B/5B 档）。
   判定：所选动作频率 ≥45% 或为该手最高频 → 对；≥15% → 半对；否则错。
   只统计正确率类指标，不做 EV 损失（数据只有每手综合 EV 且弃牌=0，算不出分动作损失）。
   ============================================== */

const STORE_KEY = "bs-pftrain-v1";
/* 自动下一手开关单独存：清空成绩不清开关 */
const AUTO_KEY = "bs-pftrain-auto-v1";

type Verdict = "ok" | "half" | "bad";
/* 作答后停留时长：答对短看一眼就走、半对/偏离多留时间复盘 */
const autoDelayOf = (v: Verdict) => (v === "ok" ? 1200 : v === "half" ? 2000 : 3500);
type Stats = {
  n: number;
  ok: number;
  good: number;
  half: number;
  bad: number;
  streak: number;
  bestStreak: number;
};
type SpotKey = "open" | "3B" | "4B" | "5B";
type SpotStats = Record<SpotKey, { n: number; ok: number }>;
type HistItem = { hand: string; pos: string; pick: string; v: Verdict; cards: [Card, Card] };

const EMPTY_STATS: Stats = {
  n: 0,
  ok: 0,
  good: 0,
  half: 0,
  bad: 0,
  streak: 0,
  bestStreak: 0,
};
const SPOT_KEYS: SpotKey[] = ["open", "3B", "4B", "5B"];
const newSpotStats = (): SpotStats => ({
  open: { n: 0, ok: 0 },
  "3B": { n: 0, ok: 0 },
  "4B": { n: 0, ok: 0 },
  "5B": { n: 0, ok: 0 },
});

function loadSaved(): { stats: Stats; spotStats: SpotStats; hist: HistItem[] } | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1) return null;
    return {
      stats: { ...EMPTY_STATS, ...d.stats },
      spotStats: { ...newSpotStats(), ...d.spotStats },
      // 逐项校验：写坏的单项（如 cards 非数组）会让 Cards 组件挂载即抛错白屏
      hist: Array.isArray(d.hist)
        ? d.hist
            .filter(
              (x: HistItem) =>
                x && typeof x === "object" && Array.isArray(x.cards) && typeof x.hand === "string"
            )
            .slice(0, 40)
        : [],
    };
  } catch {
    return null;
  }
}
function saveSaved(stats: Stats, spotStats: SpotStats, hist: HistItem[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, stats, spotStats, hist }));
  } catch {
    /* 隐私模式等场景静默失败，训练照常 */
  }
}

function scoreGrade(score: number) {
  return score >= 90 ? "S" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : "D";
}

/* 训练动作按钮文案（全中文）：弃牌 / 过牌 / 跟注 2 bb / 加注到 2.5 bb / 全下 */
function btnLabel(a: string, toCall: number, eff: number) {
  if (a === "Fold") return "弃牌";
  if (a === "Check") return "过牌";
  if (a === "Call") return toCall > 0 ? `跟注 ${fmtNum(toCall)} bb` : "跟注";
  if (a === "All-in") return `全下 ${fmtNum(eff)} bb`;
  const m = a.match(/^Raise ([\d.]+) bb$/);
  return m ? `加注到 ${m[1]} bb` : a;
}
/* 行动线/面包保留英文短动作（Raise 2 bb 是解算树动作名） */
function lineTag(a: string) {
  if (a === "All-in") return "All-in";
  if (a === "Fold" || a === "Call" || a === "Check") return a;
  const m = a.match(/^Raise ([\d.]+) bb$/);
  return m ? `Raise ${m[1]}` : a;
}
function moveKind(a: string): "fold" | "call" | "raise" | "allin" | "check" {
  if (a === "Fold") return "fold";
  if (a === "Call") return "call";
  if (a === "Check") return "check";
  if (a === "All-in") return "allin";
  return "raise";
}
/* 本节点全部可作答动作：弃牌 → 跟注/过牌 → 加注从小到大 → All-in
   0 频率动作也保留（这就是训练的干扰项），附该手频率 */
function answerList(node: PfNode, hi: number): { name: string; f: number }[] {
  return (node.a ?? [])
    .slice()
    .sort((x, y) => {
      const d = navRank(x[0]) - navRank(y[0]);
      return d !== 0 ? d : navRank(x[0]) === 2 ? actionSize(x[0]) - actionSize(y[0]) : 0;
    })
    .map(([name, q]) => ({ name, f: freqAt(q, hi) }));
}
function blindOf(seat: number, ctx: TableCtx) {
  const n = ctx.order.length;
  if (seat === ctx.order[n - 2]) return ctx.sb;
  if (seat === ctx.order[n - 1]) return ctx.bb;
  return 0;
}
/* 手牌类型：口袋对 / 同花 / 杂色——不用拼两张花色，一眼读类型 */
function handTag(hand: string): { k: "pair" | "suited" | "offsuit"; label: string } {
  if (hand.length === 2) return { k: "pair", label: "口袋对" };
  if (hand.endsWith("s")) return { k: "suited", label: "同花" };
  return { k: "offsuit", label: "杂色" };
}

function Cards({ cards, mini }: { cards?: [Card, Card] | null; mini?: boolean }) {
  if (!cards) return null;
  return (
    <span className={`tr-cards${mini ? " is-mini" : ""}`}>
      {cards.map((c, i) => (
        <span
          key={i}
          className={`tr-card${c.s === "♥" || c.s === "♦" ? " is-red" : ""}`}
        >
          <b>{c.r}</b>
          <small>{c.s}</small>
        </span>
      ))}
    </span>
  );
}

export default function PreflopTrainer({
  data,
  solId,
  solutions,
  loading,
  retryNote = 0,
  error,
  onCopyDiag,
  diagCopied = false,
  onSelectSet,
  simplify,
  onSimplifyChange,
}: {
  data: PfData | null;
  solId: string;
  solutions: { id: string; short: string; brief: string }[];
  loading: boolean;
  /* 自动重试进度（0=首次，1/2=第 n 次重试）：慢链路提示用 */
  retryNote?: number;
  error: string | null;
  /* 诊断：失败后一键复制链路遥测（页面层组装报告文本） */
  onCopyDiag?: () => void;
  diagCopied?: boolean;
  onSelectSet: (id: string) => void;
  simplify: number;
  onSimplifyChange: (s: number) => void;
}) {
  const ctx: TableCtx | null = useMemo(() => (data ? buildCtx(data) : null), [data]);
  /* 换树即换缓存：可见性行动缓存 + 筛选候选缓存（全树扫描只做一次） */
  const lineCache = useMemo(() => makeLineCache(), [data]);
  const candCache = useMemo<CandidateCache>(() => new Map(), [data]);

  const [spot, setSpot] = useState<Spot | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [ans, setAns] = useState<ReturnType<typeof scoreAnswer> | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [spotStats, setSpotStats] = useState<SpotStats>(newSpotStats);
  const [hist, setHist] = useState<HistItem[]>([]);
  const [filters, setFilters] = useState<TrainerFilters>({
    heroSeat: null,
    villainSeat: null,
    heroAction: null,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /* 自动下一手：作答后倒计时自动发牌 */
  const [autoNext, setAutoNext] = useState(false);
  const [autoLeft, setAutoLeft] = useState(0);
  /* 换树等待：pendingSet = 弹窗里点「应用」的目标树，落地（data 变引用）后由换树 effect 统一收尾 */
  const [pendingSet, setPendingSet] = useState<string | null>(null);
  const [draftSet, setDraftSet] = useState(solId);
  const [draftSimp, setDraftSimp] = useState(simplify);
  const [colStrategy, setColStrategy] = useState(false);
  const [colHero, setColHero] = useState(false);
  const [colVillain, setColVillain] = useState(false);

  const filtersRef = useRef(filters);
  const dataAtApplyRef = useRef<PfData | null>(null);

  /* 等待态派生自页面 loading / solId / error，不用 effect 维护。
     页面契约（2026-11-03 起）：solId 成功落地才前进——失败时 solId 停在旧树、
     error 非空。所以「等待」= 已申请换树、还没成功也没有失败；「失败」= 有
     error 且不在加载中（此时不管 solId 是否等于申请值都可重试/取消） */
  const settingsWaiting = pendingSet !== null && !error && (pendingSet !== solId || loading);
  const settingsError =
    pendingSet !== null && !loading && !!error ? "范围表加载失败，请重试" : "";

  /* ---- 出题 ---- */
  const dealWith = useCallback(
    (f: TrainerFilters) => {
      if (!data || !ctx) return;
      const found = makeSpot(data, ctx, lineCache, candCache, f);
      if (!found) {
        setSpot(null);
        setAns(null);
        setPick(null);
        return;
      }
      setSpot(assembleSpot(data, ctx, found));
      setAns(null);
      setPick(null);
    },
    [data, ctx, lineCache, candCache]
  );
  const deal = useCallback(() => dealWith(filtersRef.current), [dealWith]);

  /* filters 的最新值同步给 ref（渲染期写 ref 会被 lint 拦，放 effect） */
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  /* 挂载 / 换树 → 校正筛选（座位在新桌型不存在则清掉）、重出题、收换树等待 */
  useEffect(() => {
    if (!data || !ctx) return;
    /* 换树落地（data 引用变化）：收掉换树等待与设置弹窗 */
    if (pendingSet !== null && data !== dataAtApplyRef.current) {
      setPendingSet(null);
      setSettingsOpen(false);
    }
    const cur = filtersRef.current;
    const f2: TrainerFilters = {
      heroSeat: cur.heroSeat !== null && ctx.order.indexOf(cur.heroSeat) >= 0 ? cur.heroSeat : null,
      villainSeat:
        cur.villainSeat !== null && ctx.order.indexOf(cur.villainSeat) >= 0
          ? cur.villainSeat
          : null,
      heroAction: cur.heroAction,
    };
    if (
      f2.heroSeat !== cur.heroSeat ||
      f2.villainSeat !== cur.villainSeat ||
      f2.heroAction !== cur.heroAction
    )
      setFilters(f2);
    dealWith(f2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, solId]);

  /* ---- 历史成绩恢复（只跑一次；SSR 首帧渲染空态避免水合不一致） ---- */
  useEffect(() => {
    const saved = loadSaved();
    if (!saved) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage 一次性回填
    setStats(saved.stats);
    setSpotStats(saved.spotStats);
    setHist(saved.hist);
  }, []);

  /* ---- 自动下一手开关恢复（只跑一次） ---- */
  useEffect(() => {
    try {
      if (window.localStorage.getItem(AUTO_KEY) === "1") {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage 一次性回填
        setAutoNext(true);
      }
    } catch {
      /* 隐私模式等场景静默失败 */
    }
  }, []);

  const toggleAuto = useCallback((on: boolean) => {
    setAutoNext(on);
    try {
      window.localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      /* 隐私模式等场景静默失败，开关本次会话仍生效 */
    }
  }, []);

  /* ---- 自动下一手：作答后按判定档位倒计时，走完自动发牌；
     回车/空格或点「下一手」随时提前；关开关/开设置弹窗即取消 ---- */
  useEffect(() => {
    if (!ans || !autoNext || settingsOpen) return;
    const total = autoDelayOf(ans.verdict);
    const t0 = performance.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 倒计时先铺满格
    setAutoLeft(total);
    const iv = window.setInterval(() => {
      const left = total - (performance.now() - t0);
      if (left <= 0) {
        window.clearInterval(iv);
        setAutoLeft(0);
        deal();
        return;
      }
      setAutoLeft(left);
    }, 100);
    return () => window.clearInterval(iv);
  }, [ans, autoNext, settingsOpen, deal]);

  /* ---- 作答（同步算好三份新状态再统一落盘，不在 state updater 里做副作用） ---- */
  const answer = useCallback(
    (action: string) => {
      if (!spot || !ctx || ans) return;
      const a = scoreAnswer(spot.node, spot.hi, action);
      setPick(action);
      setAns(a);
      const pts = a.verdict === "ok" ? 1 : a.verdict === "half" ? 0.5 : 0;
      const spotRaises = betScan(spot.path, ctx).raises;
      // ≥4 次加注归入 5B 桶（6B+ 极罕见）。旧代码溢出置 null：该题计入总手数
      // 却不进任何分位桶，四个分位之和 < 总数（2026-11-03 审查 P3）
      const spotKey: SpotKey =
        spotRaises <= 0 ? "open" : spotRaises === 1 ? "3B" : spotRaises === 2 ? "4B" : "5B";
      const nextStats: Stats = {
        n: stats.n + 1,
        ok: stats.ok + pts,
        good: stats.good + (a.verdict === "ok" ? 1 : 0),
        half: stats.half + (a.verdict === "half" ? 1 : 0),
        bad: stats.bad + (a.verdict === "bad" ? 1 : 0),
        streak: a.verdict === "ok" ? stats.streak + 1 : 0,
        bestStreak: Math.max(stats.bestStreak, a.verdict === "ok" ? stats.streak + 1 : 0),
      };
      const nextSpots: SpotStats = {
        ...spotStats,
        [spotKey]: {
          n: spotStats[spotKey].n + 1,
          ok: spotStats[spotKey].ok + pts,
        },
      };
      const nextHist = [
        {
          hand: spot.hand,
          pos: ctx.posname[spot.seat] ?? String(spot.seat),
          pick: prettyAction(action),
          v: a.verdict,
          cards: spot.cards,
        },
        ...hist,
      ].slice(0, 40);
      setStats(nextStats);
      setSpotStats(nextSpots);
      setHist(nextHist);
      saveSaved(nextStats, nextSpots, nextHist);
    },
    [spot, ctx, ans, stats, spotStats, hist]
  );

  const clearHistory = useCallback(() => {
    const s = EMPTY_STATS;
    const sp = newSpotStats();
    setStats(s);
    setSpotStats(sp);
    setHist([]);
    saveSaved(s, sp, []);
  }, []);

  /* ---- 设置弹窗 ---- */
  const openSettings = useCallback(() => {
    if (settingsWaiting) return;
    setDraftSet(solId);
    setDraftSimp(simplify);
    setSettingsOpen(true);
  }, [settingsWaiting, solId, simplify]);
  const closeSettings = useCallback(() => {
    // 取消即放弃申请：不清理会让 settingsWaiting 挂在旧申请上
    setPendingSet(null);
    setSettingsOpen(false);
  }, []);
  const applySettings = useCallback(() => {
    if (settingsWaiting) return;
    if (
      !solutions.some((s) => s.id === draftSet) ||
      draftSimp < 0 ||
      draftSimp >= SIMP_LABELS.length
    )
      return;
    onSimplifyChange(draftSimp);
    if (draftSet === solId && !error) {
      setSettingsOpen(false);
      deal();
      return;
    }
    /* 换树：记下申请时的 data 引用，落地判定交给换树 effect（引用变了才算成功） */
    dataAtApplyRef.current = data;
    setPendingSet(draftSet);
    onSelectSet(draftSet);
  }, [settingsWaiting, solutions, draftSet, draftSimp, onSimplifyChange, solId, deal, onSelectSet, error, data]);

  /* ---- 键盘：Esc 关设置弹窗 / 数字作答 / Enter 下一手（输入框内不抢） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (settingsOpen) {
          e.preventDefault();
          closeSettings();
        }
        return;
      }
      if (settingsOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof Element && t.closest("input,textarea,select,[contenteditable]")) return;
      if (!ans) {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= 9 && spot && ctx) {
          const list = answerList(spot.node, spot.hi);
          if (list[n - 1]) {
            e.preventDefault();
            answer(list[n - 1].name);
          }
        }
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        deal();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, ans, spot, ctx, answer, deal, closeSettings]);

  /* ---------- 渲染 ---------- */
  const set = solutions.find((s) => s.id === solId) ?? solutions[0];
  const tb: TableStateT | null = spot && ctx ? tableState(spot.path, ctx) : null;
  const cmap = colorMapOf(spot?.node);
  const eff = spot && ctx ? ctx.eff[spot.seat] + blindOf(spot.seat, ctx) : 0;
  const toCall = tb && spot ? Math.max(0, tb.maxBet - (tb.contrib[spot.seat] || 0)) : 0;
  const coldBanned = spot && ctx ? isColdCall(spot.path, spot.seat, ctx) : false;
  const fs = spot ? answerList(spot.node, spot.hi) : [];
  const villain = spot && data ? lastAggressor(data, spot.key) : null;
  const pathActorsList = spot && ctx ? pathActors(spot.path, ctx).actors : [];
  const ev = spot && ctx ? handEvOf(spot.node, spot.hi) : null;
  const score = stats.n ? Math.round((100 * stats.ok) / stats.n) : 0;
  const recent = hist.slice(0, 10);
  const recentPts = recent.reduce(
    (a, h) => a + (h.v === "ok" ? 1 : h.v === "half" ? 0.5 : 0),
    0
  );
  const recentText = recent.length ? `${Math.round((100 * recentPts) / recent.length)}%` : "—";

  return (
    <div className="tr" aria-label="翻前训练">
      {/* ---------------- 左栏：设置 / 行动线 / 训练结果 / 历史 ---------------- */}
      <aside className="tr-side tr-left">
        <button
          type="button"
          className="tr-setcard"
          onClick={openSettings}
          title="更换范围表与简化策略"
        >
          <b>{set.short}</b>
          <p>{set.brief}</p>
          <p className="tr-set-simp">简化：{SIMP_LABELS[simplify]}</p>
          <span className="tr-set-link">更换范围表 ▾</span>
        </button>

        <div className="tr-lab">你的位置</div>
        <div className="tr-seg">
          {ctx && (
            <>
              <button
                type="button"
                className={filters.heroSeat === null ? "is-on" : ""}
                onClick={() => {
                  const f = { ...filtersRef.current, heroSeat: null };
                  setFilters(f);
                  dealWith(f);
                }}
              >
                任意
              </button>
              {ctx.order.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={filters.heroSeat === p ? "is-on" : ""}
                  onClick={() => {
                    const f = {
                      ...filtersRef.current,
                      heroSeat: p,
                      villainSeat:
                        filtersRef.current.villainSeat === p
                          ? null
                          : filtersRef.current.villainSeat,
                    };
                    setFilters(f);
                    dealWith(f);
                  }}
                >
                  {ctx.posname[p] ?? p}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="tr-lab">对手位置</div>
        <div className="tr-seg">
          {ctx && (
            <>
              <button
                type="button"
                className={filters.villainSeat === null ? "is-on" : ""}
                onClick={() => {
                  const f = { ...filtersRef.current, villainSeat: null };
                  setFilters(f);
                  dealWith(f);
                }}
              >
                任意
              </button>
              {ctx.order.map((p) => {
                const same = filters.heroSeat === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={`${filters.villainSeat === p ? "is-on" : ""}${same ? " is-off" : ""}`}
                    disabled={same}
                    title={same ? "这位是你的位置，不能同时当对手" : undefined}
                    onClick={() => {
                      if (same) return;
                      const f = { ...filtersRef.current, villainSeat: p };
                      setFilters(f);
                      dealWith(f);
                    }}
                  >
                    {ctx.posname[p] ?? p}
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div
          className="tr-lab"
          title="RFI=无人加注时的开局；3B=面对一注；4B=你开注被 3bet；5B=你 3bet 被 4bet"
        >
          你的行动
        </div>
        <div className="tr-seg">
          {[null, 2, 3, 4, 5].map((bet) => (
            <button
              key={bet === null ? "any" : bet}
              type="button"
              className={filters.heroAction === bet ? "is-on" : ""}
              onClick={() => {
                const f = { ...filtersRef.current, heroAction: bet };
                setFilters(f);
                dealWith(f);
              }}
            >
              {bet === null ? "任意" : bet === 2 ? "RFI" : `${bet}B`}
            </button>
          ))}
        </div>

        <div
          className="tr-lab"
          title="作答后自动发下一手：正确 1.2 秒 · 半对 2 秒 · 偏离 3.5 秒；回车/空格或点「下一手」可提前"
        >
          自动下一手
        </div>
        <div className="tr-seg">
          {[false, true].map((on) => (
            <button
              key={on ? "on" : "off"}
              type="button"
              className={autoNext === on ? "is-on" : ""}
              onClick={() => toggleAuto(on)}
            >
              {on ? "开" : "关"}
            </button>
          ))}
        </div>

        <div className="tr-rule" />

        {spot && ctx ? (
          <>
            <div className="tr-is">
              你是 <b>{ctx.posname[spot.seat] ?? spot.seat}</b>
            </div>
            <div className="tr-is">
              对手是{" "}
              {villain ? (
                <>
                  <b>{ctx.posname[villain.seat] ?? villain.seat}</b> {lineTag(villain.act)}
                </>
              ) : (
                <b>—</b>
              )}
            </div>
            <div className="tr-acts-list">
              {spot.path.map((a, i) => {
                const seat = pathActorsList[i];
                return (
                  <div className="r" key={i}>
                    <b>{ctx.posname[seat] ?? seat}</b>
                    <span className={`k-${moveKind(a)}`}>{lineTag(a)}</span>
                  </div>
                );
              })}
              <div className="r is-hero">
                <b>{ctx.posname[spot.seat] ?? spot.seat}</b>
                <span>轮到你</span>
              </div>
            </div>
          </>
        ) : (
          <div className="tr-empty-line">
            当前筛选条件下没有可训练的局面，请调整位置或行动筛选。
          </div>
        )}

        <div className="tr-rule" />
        <div className="tr-h">
          训练结果<span>正确 1 分 · 半对 0.5 分</span>
        </div>
        <div className="tr-result">
          <div className="tr-result-top">
            <div className="tr-result-score">
              <b>{stats.n ? score : "—"}</b>
              <span>/ 100</span>
            </div>
            <div className="tr-result-grade" title="S≥90 · A≥80 · B≥70 · C≥60 · D<60">
              {stats.n ? scoreGrade(score) : "—"}
            </div>
          </div>
          <div className="tr-result-bar">
            <i style={{ width: `${score}%` }} />
          </div>
          <div className="tr-result-grid">
            <span>
              正确<b>{stats.good}</b>
            </span>
            <span>
              半对<b>{stats.half}</b>
            </span>
            <span>
              偏离<b>{stats.bad}</b>
            </span>
          </div>
          <div
            className="tr-result-spots"
            title="分位正确率与综合评分同口径：正确 1 分、半对 0.5 分、偏离 0 分"
          >
            {SPOT_KEYS.map((k) => {
              const s = spotStats[k];
              const v = s.n ? `${Math.round((100 * s.ok) / s.n)}%` : "—";
              const label = k === "open" ? "开局" : k;
              return (
                <div key={k}>
                  <span>{label}</span>
                  <b>{v}</b>
                  <small>{s.n} 手</small>
                </div>
              );
            })}
          </div>
          <div className="tr-result-meta">
            <span>近 10 手 {recentText}</span>
            <span>连对 {stats.streak}</span>
            <span>最佳 {stats.bestStreak}</span>
          </div>
        </div>

        <div className="tr-rule" />
        <div className="tr-h">
          历史
          <button type="button" className="tr-hist-clear" onClick={clearHistory}>
            清空
          </button>
        </div>
        <div className="tr-hist">
          {hist.length === 0 ? (
            <div className="tr-hist-empty">还没有记录</div>
          ) : (
            hist.slice(0, 18).map((h, i) => (
              <div className="tr-hrow" key={i} title={`${h.hand} · ${h.pos} · ${h.pick}`}>
                <span className={`v v-${h.v}`}>{h.v === "ok" ? "✓" : h.v === "half" ? "±" : "✗"}</span>
                <Cards cards={h.cards} mini />
                <span className="hand">{h.hand}</span>
                <span className="pos">{h.pos}</span>
                <span className="k">{h.pick}</span>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ---------------- 中央：牌桌 / 底牌 / 动作 / 反馈 / 统计 ---------------- */}
      <main className="tr-center">
        {loading && (
          <div className="tr-loading">
            {retryNote > 0
              ? `网络较慢，第 ${retryNote}/2 次自动重试中…（请勿关闭页面）`
              : "范围表加载中…"}
          </div>
        )}

        {!loading && (!spot || !ctx || !tb) && (
          <div className="tr-nospot">
            <p>当前筛选条件下没有可训练的局面</p>
            <p className="tr-nospot-note">
              请调整左侧「你的位置 / 对手位置 / 你的行动」筛选，或更换范围表。
            </p>
            {error && (
              <>
                <p className="tr-nospot-err">加载失败：{error}</p>
                {onCopyDiag && (
                  <button
                    type="button"
                    className="tr-copy-diag"
                    onClick={onCopyDiag}
                  >
                    {diagCopied ? "诊断信息已复制 ✓" : "复制诊断信息（发给站方定位）"}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {spot && ctx && tb && (
          <>
            <div className="tr-feltwrap">
              <div className="tr-felt">
                <TrainerTable spot={spot} ctx={ctx} tb={tb} done={!!ans} />
              </div>
            </div>

            <div className="tr-hole">
              <Cards cards={spot.cards} />
              <span className={`tr-hole-tag is-${handTag(spot.hand).k}`}>
                {handTag(spot.hand).label}
              </span>
            </div>

            <div className="tr-btns">
              {fs.map((x, i) => (
                <button
                  key={x.name}
                  type="button"
                  className={
                    ans && pick === x.name
                      ? `tr-btn is-pick is-${ans.verdict === "ok" ? "win" : ans.verdict}`
                      : "tr-btn"
                  }
                  disabled={!!ans}
                  onClick={() => answer(x.name)}
                >
                  <span>{btnLabel(x.name, toCall, eff)}</span>
                  {ans ? <i className="pct">{Math.round(100 * x.f)}%</i> : <i className="key">{i + 1}</i>}
                </button>
              ))}
            </div>

            <div className="tr-feed">
              {!ans ? (
                <>
                  <span>
                    点击动作作答 · 你是 <b>{ctx.posname[spot.seat] ?? spot.seat}</b>
                  </span>
                  <span className="tr-feed-dim">
                    {" "}
                    · {spot.hand}
                    {toCall > 0 ? ` · 需跟 ${fmtNum(toCall)} bb` : ""}
                    {coldBanned ? " · 冷 call 3B 已屏蔽" : ""}
                  </span>
                </>
              ) : (
                <div className="tr-fb">
                  <div className="tr-fb-head">
                    <b className={`v-${ans.verdict}`}>
                      {ans.verdict === "ok" ? "✓ 正确" : ans.verdict === "half" ? "± 半对" : "✗ 偏离"}
                    </b>
                    <span className="tr-fb-hand">
                      {spot.hand} · GTO 频率
                    </span>
                    <button type="button" className="tr-next" onClick={deal}>
                      {autoNext ? `下一手 · ${(autoLeft / 1000).toFixed(1)}s` : "下一手 →"}
                    </button>
                  </div>
                  {/* 长条 = 这手牌的动作频率：颜色=动作色，长度=频率；白框=你选的那档 */}
                  <div className="tr-fb-bar">
                    {fs
                      .filter((x) => x.f > 0.005)
                      .map((x) => (
                        <span
                          key={x.name}
                          className={pick === x.name ? "is-pick" : ""}
                          style={{
                            width: `${(100 * x.f).toFixed(2)}%`,
                            background: rgba(colorOf(cmap, x.name), 0.95),
                          }}
                        />
                      ))}
                  </div>
                  <div className="tr-fb-list">
                    {fs.map((x) => {
                      const isPick = pick === x.name;
                      const isBest = ans.bestName === x.name;
                      return (
                        <span
                          key={x.name}
                          className={`tr-fb-item${isPick ? " is-pick" : ""}`}
                        >
                          <i className="dot" style={{ background: rgba(colorOf(cmap, x.name), 0.95) }} />
                          {btnLabel(x.name, toCall, eff)}
                          <em>{Math.round(100 * x.f)}%</em>
                          {isPick && <b className="tag tag-pick">你选</b>}
                          {isBest && !isPick && <b className="tag tag-best">最优</b>}
                        </span>
                      );
                    })}
                  </div>
                  {/* 自动下一手倒计时：细条走完自动发下一手 */}
                  {autoNext && (
                    <i
                      className="tr-fb-timer"
                      style={{ width: `${(100 * autoLeft) / autoDelayOf(ans.verdict)}%` }}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="tr-statsbar">
              <div className="tr-stat">
                <span className="l">手数</span>
                <span className="v">{stats.n}</span>
              </div>
              <div className="tr-stat">
                <span className="l">偏离</span>
                <span className="v">{stats.bad}</span>
              </div>
              <div className="tr-stat">
                <span className="l">正确率</span>
                <span className="v">{stats.n ? `${score}%` : "—"}</span>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ---------------- 右栏：策略矩阵 ---------------- */}
      <aside className="tr-side tr-right">
        <button
          type="button"
          className="tr-strategy-head"
          aria-expanded={!colStrategy}
          onClick={() => setColStrategy((v) => !v)}
        >
          <i className="tr-caret">{colStrategy ? "▸" : "▾"}</i>策略
        </button>
        {spot && ctx && (
          <div hidden={colStrategy}>
            <div className="tr-herorange">
              <button
                type="button"
                className="tr-range-head"
                aria-expanded={!colHero}
                onClick={() => setColHero((v) => !v)}
              >
                <b>你的范围</b>
                <span>
                  {ctx.posname[spot.seat] ?? spot.seat} 轮到行动
                  <i className="tr-caret">{colHero ? "▸" : "▾"}</i>
                </span>
              </button>
              {!colHero && (
                <div className="tr-range-body">
                  <div className="tr-legend">
                    {aggPcts(spot.node, ctx).map((a) => (
                      <span key={a.name} className="li">
                        <i
                          className="sw"
                          style={{ background: rgba(colorOf(cmap, a.name), 0.95) }}
                        />
                        {prettyAction(a.name)} {(100 * a.p).toFixed(1)}%
                      </span>
                    ))}
                  </div>
                  <div className="tr-matrix">
                    <HeroMatrix node={spot.node} ctx={ctx} hi={spot.hi} simplify={simplify} />
                  </div>
                  <div className="tr-detail">
                    <div className="tr-sub">
                      这手牌 · {spot.hand}
                      {ev !== null && (
                        <span className="tr-ev">
                          {" "}
                          EV {ev > 0 ? "+" : ""}
                          {ev.toFixed(2)} bb
                        </span>
                      )}
                    </div>
                    {fs.map((x) => (
                      <div
                        key={x.name}
                        className={`tr-lrow${ans && x.name === ans.bestName ? " is-best" : ""}`}
                      >
                        <span className="nm">{prettyAction(x.name)}</span>
                        <span className="bar">
                          <i
                            style={{
                              width: `${(100 * x.f).toFixed(1)}%`,
                              background: rgba(colorOf(cmap, x.name), 0.95),
                            }}
                          />
                        </span>
                        <span className="pc">{Math.round(100 * x.f)}%</span>
                      </div>
                    ))}
                    <p className="tr-note">
                      判定：所选动作频率 ≥45% 或为该手最高频 → 对；≥15% → 半对；其余为偏离。
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="tr-vrange">
              <button
                type="button"
                className="tr-range-head"
                aria-expanded={!colVillain}
                onClick={() => setColVillain((v) => !v)}
              >
                <b>对手范围</b>
                <span>
                  {villain
                    ? `${ctx.posname[villain.seat] ?? villain.seat} · ${lineTag(villain.act)}`
                    : "—"}
                  <i className="tr-caret">{colVillain ? "▸" : "▾"}</i>
                </span>
              </button>
              {!colVillain && (
                <div className="tr-range-body">
                  {villain ? (
                    <>
                      <div className="tr-vsub">
                        行动线最后动作 · 该动作整体频率{" "}
                        {(
                          100 *
                          (aggPcts(villain.node, ctx).find((a) => a.name === villain.act)?.p ?? 0)
                        ).toFixed(1)}
                        %
                      </div>
                      <div className="tr-matrix">
                        <VillainMatrix villain={villain} ctx={ctx} />
                      </div>
                    </>
                  ) : (
                    <div className="tr-vempty">当前行动线还没有对手动作</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* ---------------- 训练设置弹窗 ---------------- */}
      {settingsOpen && (
        <div className="tr-modal" role="dialog" aria-modal="true" aria-label="训练设置">
          <div className="tr-modal-backdrop" onClick={closeSettings} />
          <div className="tr-modal-card">
            <div className="tr-modal-head">
              <div>
                <h2>训练设置</h2>
                <p>选择范围表与简化策略，确认后重新出题</p>
              </div>
              <button
                type="button"
                className="tr-modal-x"
                aria-label="关闭训练设置"
                onClick={closeSettings}
                disabled={settingsWaiting}
              >
                ✕
              </button>
            </div>
            <span className="tr-modal-label">范围表类型</span>
            <div className="tr-set-options">
              {solutions.map((s) => {
                const on = s.id === draftSet;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`tr-set-option${on ? " is-on" : ""}`}
                    disabled={settingsWaiting}
                    aria-pressed={on}
                    onClick={() => setDraftSet(s.id)}
                  >
                    <span>
                      <b>{s.short}</b>
                      <small>{s.brief}</small>
                    </span>
                    <span className="tr-option-check">{on ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
            <span className="tr-modal-label">简化策略</span>
            <div className="tr-simp-options">
              {SIMP_LABELS.map((lb, i) => (
                <button
                  key={lb}
                  type="button"
                  className={`tr-simp-option${i === draftSimp ? " is-on" : ""}`}
                  disabled={settingsWaiting}
                  aria-pressed={i === draftSimp}
                  onClick={() => setDraftSimp(i)}
                >
                  {i === 0 ? "原始频率" : `${lb} 档`}
                </button>
              ))}
            </div>
            <p className="tr-modal-note">
              简化策略只改变范围表的频率分档；作答判定始终使用解算树的原始频率。
            </p>
            <p className="tr-modal-error" aria-live="polite">
              {settingsError}
            </p>
            <div className="tr-modal-foot">
              <button
                type="button"
                className="tr-modal-btn"
                onClick={closeSettings}
                disabled={settingsWaiting}
              >
                取消
              </button>
              <button
                type="button"
                className="tr-modal-btn is-primary"
                onClick={applySettings}
                disabled={settingsWaiting}
              >
                {settingsWaiting ? "加载范围表…" : "应用并重新出题"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 训练桌：座位 / 筹码 / 底池 ----------------
   座位坐标用名义尺寸算百分比：stadium 几何随容器线性缩放，无需监听 resize */
function TrainerTable({
  spot,
  ctx,
  tb,
  done,
}: {
  spot: Spot;
  ctx: TableCtx;
  tb: TableStateT;
  done: boolean;
}) {
  const FW = 1075;
  const FH = 500;
  const R = FH / 2;
  const A = FW / 2 - R;
  const N = ctx.order.length;
  const heroIdx = ctx.order.indexOf(spot.seat);
  const rot = 0.5 - (heroIdx + 1) / N;

  const seats: ReactNode[] = [];
  const bets: ReactNode[] = [];
  ctx.order.forEach((p, k) => {
    const [px, py] = stadiumPoint((k + 1) / N + rot, A, R);
    const left = ((FW / 2 + px) / FW) * 100;
    const top = ((FH / 2 + py) / FH) * 100;
    const isHero = p === spot.seat;
    const folded = !!tb.folded[p];
    const mv = tb.last[p];
    const acting = !!(mv && !folded && !isHero);
    const stackLeft = Math.max(
      0,
      Math.round(
        ((ctx.eff[p] ?? ctx.stack) + blindOf(p, ctx) - (tb.contrib[p] || 0)) * 10
      ) / 10
    );
    const parts: ReactNode[] = [
      <b key="pos">{ctx.posname[p] ?? p}</b>,
      <span key="stk">{tb.allin[p] ? "ALL-IN" : `${fmtNum(stackLeft)} bb`}</span>,
    ];
    if (p === 0) parts.push(<i key="dealer" className="tr-dealer">D</i>);
    if (mv) parts.push(<i key="mv" className={`tr-move k-${mv.kind}`}>{mv.label}</i>);
    if (!folded && !isHero) {
      const vc = done ? spot.vhands[p] : null;
      parts.push(
        vc ? (
          <span
            key="ups"
            className="tr-ups"
            title="按这个对手在该动作上的频率随机抽的一手牌，不是他的真实底牌"
          >
            <Cards cards={vc} />
          </span>
        ) : (
          <span key="backs" className="tr-backs" aria-hidden="true">
            <i />
            <i />
          </span>
        )
      );
    }
    seats.push(
      <div
        key={p}
        className={`tr-seat${isHero ? " is-hero" : ""}${folded ? " is-fold" : ""}${
          acting ? " is-act" : ""
        }${py < 0 ? " is-up" : ""}${px < 0 ? " is-left" : ""}`}
        style={{ left: `${left.toFixed(2)}%`, top: `${top.toFixed(2)}%` }}
      >
        {parts}
      </div>
    );
    const put = tb.contrib[p] || 0;
    if (put > 0) {
      const bx = ((FW / 2 + px * 0.62) / FW) * 100;
      const by = ((FH / 2 + py * 0.62) / FH) * 100;
      bets.push(
        <div
          key={`bet-${p}`}
          className={`tr-bet k-${mv ? mv.kind : "blind"}`}
          style={{ left: `${bx.toFixed(2)}%`, top: `${by.toFixed(2)}%` }}
        >
          <span className="tr-chips" aria-hidden="true">
            <i />
            <i />
          </span>
          <span className="tr-amt">{fmtNum(Math.round(put * 10) / 10)}</span>
        </div>
      );
    }
  });

  const pot = Math.round(10 * tb.pot) / 10;
  return (
    <>
      {seats}
      {bets}
      <div className="tr-pot">
        <div className="tr-pot-line">
          <i />
          POT {fmtNum(pot)}
        </div>
        <div className="tr-pot-meta">
          {N} 人桌 · {fmtNum(ctx.stack)}bb
        </div>
      </div>
    </>
  );
}

/* ---------------- 你的范围矩阵（高亮这手牌） ---------------- */
function HeroMatrix({
  node,
  ctx,
  hi,
  simplify,
}: {
  node: PfNode;
  ctx: TableCtx;
  hi: number;
  simplify: number;
}) {
  const cmap = colorMapOf(node);
  const cells: ReactNode[] = [];
  for (let ri = 0; ri < 13; ri++) {
    for (let ci = 0; ci < 13; ci++) {
      const r = RANKS[ri];
      const c = RANKS[ci];
      const hand = ri === ci ? r + r : ci > ri ? r + c + "s" : c + r + "o";
      const idx = ctx.hands.indexOf(hand);
      const segs = idx >= 0 ? cellSegments(node.a ?? [], idx, simplify) : [];
      cells.push(
        <i key={hand} className={`tr-cell${idx >= 0 && idx === hi ? " is-hero" : ""}`} title={hand}>
          {segs.map((sg) => (
            <b
              key={sg.an}
              style={{
                width: `${(100 * sg.f).toFixed(1)}%`,
                background: rgba(colorOf(cmap, sg.an), alphaOf(sg.an)),
              }}
            />
          ))}
          <span>{hand}</span>
        </i>
      );
    }
  }
  return <>{cells}</>;
}

/* ---------------- 对手范围矩阵（该动作的 169 手频率） ---------------- */
function VillainMatrix({
  villain,
  ctx,
}: {
  villain: { seat: number; act: string; node: PfNode; key: string };
  ctx: TableCtx;
}) {
  const cmap = colorMapOf(villain.node);
  const it = villain.node.a?.find(([n]) => n === villain.act) ?? null;
  const cells: ReactNode[] = [];
  for (let ri = 0; ri < 13; ri++) {
    for (let ci = 0; ci < 13; ci++) {
      const r = RANKS[ri];
      const c = RANKS[ci];
      const hand = ri === ci ? r + r : ci > ri ? r + c + "s" : c + r + "o";
      const idx = ctx.hands.indexOf(hand);
      const f = idx >= 0 && it ? freqAt(it[1], idx) : 0;
      cells.push(
        <i
          key={hand}
          className="tr-cell"
          title={`${hand} · ${lineTag(villain.act)} ${Math.round(100 * f)}%`}
        >
          {f > 0.03 ? (
            <b
              style={{
                width: `${(100 * f).toFixed(1)}%`,
                background: rgba(colorOf(cmap, villain.act), 0.95),
              }}
            />
          ) : null}
          <span>{hand}</span>
        </i>
      );
    }
  }
  return <>{cells}</>;
}
