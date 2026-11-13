"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Navbar from "@/app/components/Navbar";
import ToolHeader from "@/app/components/ToolHeader";
import SiteFooter from "@/app/components/SiteFooter";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  genId,
  beep,
  notify,
  notifyStatus,
  requestNotifyPermission,
  type NotifyStatus,
  fmtMin,
  fmtClock,
  tallyBlocks,
  feelLabel,
  feelTone,
  feelSummary,
  isBlockBlank,
  FEEL_LEVELS,
  type BlockEntry,
  type FeelLevel,
  type Settings,
} from "@/lib/pomodoro";
import {
  fetchMe,
  saveRecord,
  listRecords,
  deleteRecord,
  fmtDate,
  type MeUser,
  type PomoRecord,
  type PomoRecordInput,
} from "./cloud";
import "./pomodoro.css";

type Phase = "idle" | "focus" | "break";

interface RunningState {
  phase: Phase;
  isLongBreak: boolean; // 当前 break 是不是长休
  running: boolean;
  secsLeft: number;
  phaseTotal: number; // 当前阶段总秒数（画环用）
}

const INIT: RunningState = {
  phase: "idle",
  isLongBreak: false,
  running: false,
  secsLeft: 0,
  phaseTotal: 1,
};

const TILT_DESC = ["佛系", "平静", "略躁", "上头", "爆缸"];

export default function Pomodoro() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  // 本次 session 的块记录（纯内存）
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [sessionStartTs, setSessionStartTs] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);

  const [rs, setRs] = useState<RunningState>(INIT);
  const [ended, setEnded] = useState<null | { focusMin: number; reason: string }>(null);

  const [showSettings, setShowSettings] = useState(true);

  // 右下角阶段提醒气泡（配系统通知，页面最小化靠后者提醒）
  const [toast, setToast] = useState<null | { icon: string; title: string; text: string }>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 桌面通知权限状态（设置面板里给提示用）
  const [notifyPerm, setNotifyPerm] = useState<NotifyStatus>("unsupported");

  /* ---------- 会员云历史：登录态 + 本次收工复盘的保存状态 ---------- */
  const [me, setMe] = useState<MeUser | null>(null);
  const [saveState, setSaveState] = useState<
    | null
    | { state: "saving" | "saved" | "error"; rec: PomoRecordInput }
  >(null);
  const [histOpen, setHistOpen] = useState(false);
  const [hist, setHist] = useState<PomoRecord[] | null>(null); // null = 还没拉过
  const [histErr, setHistErr] = useState<string | null>(null);
  const [histBusyId, setHistBusyId] = useState<string | null>(null); // 正在删除的记录 id

  // 计时器：用 endTimeRef 抗漂移
  const endTimeRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 阶段完成回调的 ref：计时 interval 捕获的是 effect 启动那一刻的闭包，
  // 自动衔接时 effect 不重跑，必须每次渲染同步最新回调供 tick 调用
  const handlePhaseCompleteRef = useRef<() => void>(() => {});

/* ---------- hydrate settings ---------- */
useEffect(() => {
  setSettings(loadSettings());
  setHydrated(true);
}, []);

/* ---------- 会员登录态：进页拉一次；别页登录登出会广播 bs-me ---------- */
useEffect(() => {
  void fetchMe().then(setMe);
}, []);
useEffect(() => {
  const onMe = (e: Event) => setMe((e as CustomEvent).detail ?? null);
  window.addEventListener("bs-me", onMe);
  return () => window.removeEventListener("bs-me", onMe);
}, []);

  /* ---------- 桌面通知：跟踪权限状态（授权弹窗回来后窗口聚焦时刷新） ---------- */
  useEffect(() => {
    const refresh = () => setNotifyPerm(notifyStatus());
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  /* ---------- toast 定时器卸载清理 ---------- */
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  /* ---------- 主计时循环 ---------- */
  useEffect(() => {
    if (!rs.running) {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    const tick = () => {
      if (endTimeRef.current == null) return;
      const remain = Math.ceil((endTimeRef.current - Date.now()) / 1000);
      if (remain <= 0) {
        setRs((prev) => ({ ...prev, secsLeft: 0, running: false }));
        endTimeRef.current = null;
        // 经 ref 调最新闭包：effect 只依赖 rs.running，自动衔接时 running 在同一
        // 批次里 false→true、effect 不重跑，interval 里捕获的还是阶段开始时的旧
        // handlePhaseComplete（旧 rs.phase / 旧 blocks / 旧 settings）——休息结束
        // 会再走一遍「专注完成」分支：重复落块覆盖笔记 + 无限休息循环
        // （2026-11-03 审查 P1）。ref 每次渲染同步到最新，tick 永远调到当下。
        handlePhaseCompleteRef.current();
      } else {
        setRs((prev) => (prev.secsLeft === remain ? prev : { ...prev, secsLeft: remain }));
      }
    };
    tick();
    tickRef.current = setInterval(tick, 250);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [rs.running]);

  /* ---------- 标签页 title 显示倒计时（副屏/最小化可见） ---------- */
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (rs.phase !== "idle" && !ended) {
      const phaseText = rs.phase === "focus" ? "专注" : rs.isLongBreak ? "长休" : "短休";
      document.title = `${fmtClock(rs.secsLeft)} ${phaseText} · 扑克番茄钟`;
    } else {
      document.title = "扑克番茄钟 · BanSolver";
    }
  }, [rs.secsLeft, rs.phase, rs.isLongBreak, ended]);

  /* ---------- 阶段控制 ---------- */
  // 右下角气泡：每阶段结束滑入一张，12 秒自动消失
  const showToast = useCallback((icon: string, title: string, text: string) => {
    setToast({ icon, title, text });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 12000);
  }, []);

  // autoRun: 是否自动启动计时。手动开始时强制 true；自动衔接下一阶段时看 autoStartNext 设置
  const beginPhase = useCallback(
    (phase: Phase, isLong = false, autoRun?: boolean) => {
      let total: number;
      if (phase === "focus") total = settings.focusMin * 60;
      else total = (isLong ? settings.longBreakMin : settings.shortBreakMin) * 60;
      endTimeRef.current = Date.now() + total * 1000;
      setEndedAt(null);
      const run = autoRun !== undefined ? autoRun : settings.autoStartNext;
      setRs({ phase, isLongBreak: isLong, running: run, secsLeft: total, phaseTotal: total });
    },
    [settings],
  );

  const startSession = () => {
    if (settings.notifyOn) {
      // 浏览器只允许在用户手势里请求授权：首次点「开始」时弹询问
      requestNotifyPermission((perm) => setNotifyPerm(perm));
    }
    setBlocks([]);
    setSessionStartTs(Date.now());
    setEnded(null);
    setEndedAt(null);
    beginPhase("focus", false, true); // 手动开始，强制启动计时
  };

  const togglePause = () => {
    if (rs.phase === "idle") return;
    if (rs.running) {
      // 暂停
      endTimeRef.current = null;
      setRs((p) => ({ ...p, running: false }));
    } else {
      // 继续
      endTimeRef.current = Date.now() + rs.secsLeft * 1000;
      setRs((p) => ({ ...p, running: true }));
    }
  };

  const skipPhase = () => {
    endTimeRef.current = null;
    setRs((p) => ({ ...p, running: false, secsLeft: 0 }));
    handlePhaseComplete();
  };

  /* 一阶段自然/手动结束 */
  const handlePhaseComplete = () => {
    if (rs.phase === "focus") {
      // 专注块完成 → 落一条块笔记
      const idx = blocks.length + 1;
      const entry: BlockEntry = {
        id: genId(),
        index: idx,
        ts: Date.now(),
        tilt: 3,
        feel: null,
        note: "",
      };
      const newBlocks = [...blocks, entry];
      setBlocks(newBlocks);

      if (settings.soundOn) beep("focus-end");

      // 防上头刹车
      if (settings.maxBlocksPerSession > 0 && idx >= settings.maxBlocksPerSession) {
        if (settings.notifyOn) notify("本次上限已到", `已完成 ${idx} 块，建议收工。`);
        showToast("🏁", "本次打完", `达到上限 ${idx} 块，建议收工。`);
        endSession(`达到本次上限 ${idx} 块，建议收工`);
        return;
      }
      // 决定休息类型
      const isLong = idx % settings.cyclesBeforeLongBreak === 0;
      const breakMin = isLong ? settings.longBreakMin : settings.shortBreakMin;
      // 阶段提醒：页面最小化靠系统通知，页面可见时右下角气泡兜底
      if (settings.notifyOn) notify("专注结束", `第 ${idx} 块打完，${isLong ? "长休" : "短休"} ${breakMin} 分钟。`);
      showToast("📣", "专注结束", `第 ${idx} 块打完，该${isLong ? "长休" : "短休"}了。`);
      beginPhase("break", isLong);
    } else if (rs.phase === "break") {
      if (settings.soundOn) beep("break-end");
      if (settings.notifyOn) notify("休息结束", "休息完了，回来开打。");
      showToast("⚡", "休息结束", "回来，该开打下一块了。");
      beginPhase("focus");
    }
  };
  // 每次渲染后同步最新闭包（interval 是宏任务，必然晚于本轮 commit，
  // 读到的一定是当下版本的 handlePhaseComplete）
  useEffect(() => {
    handlePhaseCompleteRef.current = handlePhaseComplete;
  });

  /* ---------- 会员云历史 ---------- */
  const refreshHist = useCallback(async () => {
    setHistErr(null);
    try {
      setHist(await listRecords());
    } catch (e) {
      setHistErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  const doSave = useCallback(
    async (rec: PomoRecordInput) => {
      setSaveState({ state: "saving", rec });
      try {
        await saveRecord(rec);
        setSaveState({ state: "saved", rec });
        // 面板已经拉过列表就顺手刷新，新复盘立刻可见
        if (hist !== null) void refreshHist();
      } catch {
        setSaveState({ state: "error", rec });
      }
    },
    [hist, refreshHist]
  );

  const toggleHist = () => {
    const next = !histOpen;
    setHistOpen(next);
    if (next && me && hist === null) void refreshHist();
  };

  const doDeleteHist = async (id: string) => {
    if (histBusyId) return;
    setHistBusyId(id);
    try {
      await deleteRecord(id);
      setHist((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch {
      setHistErr("删除失败，稍后再试");
    } finally {
      setHistBusyId(null);
    }
  };

  const endSession = (reason = "手动结束") => {
    const now = Date.now();
    endTimeRef.current = null;
    setEndedAt(now);
    setRs((p) => ({ ...p, running: false, phase: "idle" }));
    const focusMin = blocks.length * settings.focusMin;
    setEnded({ focusMin, reason });
    // 会员云历史：有空块的收工复盘自动入云（未登录不打扰，本地行为不变）
    if (me && sessionStartTs && blocks.length > 0) {
      const t = tallyBlocks(blocks);
      void doSave({
        startedAt: sessionStartTs,
        endedAt: now,
        blocks: blocks.length,
        focusMin,
        elapsedSec: Math.round((now - sessionStartTs) / 1000),
        avgTilt: t.avgTilt,
        reason,
        feelCounts: t.feelCounts,
        blocksData: blocks,
      });
    } else {
      setSaveState(null); // 空场次不存云，也别把上一次的保存状态带进这次总结
    }
  };

  const restart = () => {
    setBlocks([]);
    setSessionStartTs(null);
    setEnded(null);
    setEndedAt(null);
    setRs(INIT);
    endTimeRef.current = null;
  };

  /* ---------- 块笔记编辑 ---------- */
  const updateLastBlock = (patch: Partial<BlockEntry>) => {
    setBlocks((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  };

  /* ---------- 派生 ---------- */
  const tally = tallyBlocks(blocks);
  // 实际耗时：ended 时用 endedAt 锁定，运行中用 now
  const realElapsedSec = sessionStartTs
    ? Math.round(((endedAt ?? Date.now()) - sessionStartTs) / 1000)
    : 0;

  // 上头预警：最近一块 tilt >= 4
  const tiltWarn = blocks.length > 0 && blocks[blocks.length - 1].tilt >= 4;
  // 接近上限
  const nearLimit =
    settings.maxBlocksPerSession > 0 &&
    blocks.length >= settings.maxBlocksPerSession - 1 &&
    blocks.length < settings.maxBlocksPerSession;
  // 最新块是否未填
  const latestBlank = blocks.length > 0 && isBlockBlank(blocks[blocks.length - 1]);
  // 当前是第几块（正在打的）
  const curBlockNum = rs.phase === "focus" ? blocks.length + 1 : blocks.length;

  /* ---------- 渲染 ---------- */
  if (!hydrated) {
    return (
      <>
        <Navbar />
        <section className="section" style={{ paddingTop: "7rem", minHeight: "60vh" }} />
      </>
    );
  }

  const ringColor = rs.phase === "focus" ? "#c4a455" : rs.phase === "break" ? "#2dd4bf" : "#3f3f46";
  const progress = rs.phaseTotal > 0 ? 1 - rs.secsLeft / rs.phaseTotal : 0;
  const phaseText =
    rs.phase === "focus" ? "专注中" : rs.phase === "break" ? (rs.isLongBreak ? "长休" : "短休") : "就绪";

  return (
    <>
      <Navbar />
      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner" style={{ maxWidth: "1200px" }}>
          <ToolHeader
            kicker="工具台 / 专注工具"
            title="扑克番茄钟"
            glyph="pomodoro"
          />

          {/* ===== 上头 / 上限 预警横幅 ===== */}
          {tiltWarn && rs.phase !== "idle" && !ended && (
            <div className="pomo-banner pomo-banner--warn">
              ⚠️ 上一块上头指数 {blocks[blocks.length - 1].tilt}/5。这一块结束建议直接收工，别加码。
            </div>
          )}
          {nearLimit && rs.phase !== "idle" && !ended && (
            <div className="pomo-banner pomo-banner--info">
              剩最后一块就要触发本次上限（{settings.maxBlocksPerSession} 块）。打完这局系统会自动喊停。
            </div>
          )}

          {/* ===== 主区域：结束总结 / 计时器 ===== */}
          {ended ? (
            <SummaryCard
              ended={ended}
              blocks={blocks}
              tally={tally}
              realElapsedSec={realElapsedSec}
              onRestart={restart}
              saveState={saveState}
              onRetrySave={() => {
                if (saveState) void doSave(saveState.rec);
              }}
            />
          ) : rs.phase === "idle" && blocks.length === 0 ? (
            <IdleStart onStart={startSession} />
          ) : (
            <>
              {/* ===== 紧凑信息顶栏：扫一眼抓关键 ===== */}
              <div className="pomo-status-bar card">
                <div className="pomo-status-block">
                  <span className="pomo-status-label">第</span>
                  <span className="pomo-status-num">{curBlockNum}</span>
                  <span className="pomo-status-label">块</span>
                </div>
                <div className="pomo-status-dots">
                  {Array.from({ length: Math.max(blocks.length + (rs.phase === "focus" ? 1 : 0), 1) }).map((_, i) => (
                    <span
                      key={i}
                      className={`pomo-sdot ${
                        i < blocks.length ? "pomo-sdot--done" : i === blocks.length && rs.phase === "focus" ? "pomo-sdot--cur" : ""
                      }`}
                    />
                  ))}
                  {settings.maxBlocksPerSession > 0 && (
                    <span className="pomo-status-cap">/ {settings.maxBlocksPerSession}</span>
                  )}
                </div>
                <div className="pomo-status-phase" style={{ color: ringColor }}>
                  {phaseText}
                </div>
              </div>

              {/* ===== 计时器：圆环 + 放大数字 ===== */}
              <div className="pomo-timer-card card">
                <div className="pomo-ring-wrap">
                  <svg className="pomo-ring" viewBox="0 0 220 220">
                    <circle className="pomo-ring-track" cx="110" cy="110" r="96" />
                    <circle
                      className="pomo-ring-fill"
                      cx="110"
                      cy="110"
                      r="96"
                      stroke={ringColor}
                      strokeDasharray={2 * Math.PI * 96}
                      strokeDashoffset={2 * Math.PI * 96 * (1 - progress)}
                      style={{ transition: "stroke-dashoffset 0.3s linear" }}
                    />
                  </svg>
                  <div className="pomo-ring-center">
                    <div className="pomo-clock">{fmtClock(rs.secsLeft)}</div>
                    <div className="pomo-phase-label" style={{ color: ringColor }}>
                      {phaseText}
                    </div>
                  </div>
                </div>

                {/* 控制按钮 */}
                <div className="pomo-controls">
                  <button className="btn-gold pomo-ctrl-btn" onClick={togglePause}>
                    {rs.running ? "暂停" : "继续"}
                  </button>
                  {rs.phase === "focus" ? (
                    <>
                      <button className="btn-outline pomo-ctrl-btn" onClick={skipPhase}>
                        提前结束这块
                      </button>
                    </>
                  ) : (
                    <button className="btn-outline pomo-ctrl-btn" onClick={skipPhase}>
                      结束休息，立即开打
                    </button>
                  )}
                  <button className="pomo-ctrl-btn pomo-end-btn" onClick={() => endSession("手动结束")}>
                    结束本次
                  </button>
                </div>
              </div>

              {/* ===== 两栏：本轮记录 + 仪表盘 ===== */}
              <div className="pomo-grid">
                {/* 本轮记录（最新一块可编辑） */}
                <div className="card pomo-panel">
                  <div className="pomo-panel-head">
                    <h3>本轮记录</h3>
                    <span className="pomo-panel-sub">每块结束花 10 秒填一下</span>
                  </div>

                  {/* 休息时的填笔记提示条 */}
                  {rs.phase === "break" && blocks.length > 0 && (
                    <div className={`pomo-note-prompt ${latestBlank ? "pomo-note-prompt--todo" : "pomo-note-prompt--done"}`}>
                      {latestBlank ? (
                        <>⏸️ 休息中 — 花 10 秒填一下第 {blocks.length} 块的手感</>
                      ) : (
                        <>✓ 第 {blocks.length} 块已记录</>
                      )}
                    </div>
                  )}

                  {blocks.length === 0 ? (
                    <p className="pomo-empty">第一块专注还没结束，先安心打牌。</p>
                  ) : (
                    <BlockNoteEditor
                      block={blocks[blocks.length - 1]}
                      isLatest
                      onChange={(patch) => updateLastBlock(patch)}
                    />
                  )}

                  {blocks.length > 1 && (
                    <div className="pomo-past">
                      <div className="pomo-past-head">历史块（本次）</div>
                      {blocks
                        .slice(0, -1)
                        .reverse()
                        .map((b) => (
                          <BlockHistoryRow key={b.id} block={b} />
                        ))}
                    </div>
                  )}
                </div>

                {/* 仪表盘 */}
                <div className="card pomo-panel">
                  <div className="pomo-panel-head">
                    <h3>本次仪表盘</h3>
                    <span className="pomo-panel-sub">实时</span>
                  </div>

                  <div className="pomo-stat-grid">
                    <Stat label="已完成块" value={String(tally.completedBlocks)} />
                    <Stat label="专注时长" value={fmtMin(blocks.length * settings.focusMin)} />
                    <Stat
                      label="手感分布"
                      value={feelSummary(tally.feelCounts)}
                      tone={tally.completedBlocks >= 2 && tally.feelCounts.big_loss + tally.feelCounts.small_loss > tally.feelCounts.big_win + tally.feelCounts.small_win ? "neg" : "neutral"}
                    />
                    <Stat
                      label="平均上头"
                      value={
                        tally.avgTilt != null
                          ? tally.completedBlocks >= 2
                            ? tally.avgTilt.toFixed(1)
                            : "数据不足"
                          : "—"
                      }
                      tone={tally.avgTilt != null && tally.avgTilt >= 3.5 && tally.completedBlocks >= 2 ? "neg" : "neutral"}
                      dim={tally.completedBlocks < 2}
                    />
                  </div>

                  {/* tilt 趋势 sparkline */}
                  <div className="pomo-trend">
                    <div className="pomo-trend-label">上头趋势</div>
                    {tally.tiltSeries.length > 0 ? (
                      <TiltSpark data={tally.tiltSeries} />
                    ) : (
                      <div className="pomo-trend-empty">还没有数据</div>
                    )}
                  </div>

                  <div className="pomo-elapsed">
                    本次已进行 <strong>{fmtMin(realElapsedSec / 60)}</strong>
                    {sessionStartTs && (
                      <>，开始于 {new Date(sessionStartTs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ===== 设置 ===== */}
          <div className="pomo-settings-wrap">
            <button className="pomo-settings-toggle" onClick={() => setShowSettings((s) => !s)}>
              {showSettings ? "收起设置 ▴" : "设置（时长 / 上限 / 提醒） ▾"}
            </button>
            {showSettings && (
              <SettingsPanel
                settings={settings}
                notifyPerm={notifyPerm}
                onChange={(s) => {
                  setSettings(s);
                  saveSettings(s);
                  // 刚打开桌面通知开关 → 现在请求授权（用户手势内）
                  if (s.notifyOn && !settings.notifyOn) {
                    requestNotifyPermission((perm) => setNotifyPerm(perm));
                  }
                }}
              />
            )}
          </div>

          {/* ===== 会员历史记录：登录后每次收工复盘自动入云，可回看一句话手感 ===== */}
          <div className="pomo-history-wrap">
            <button className="pomo-settings-toggle" onClick={toggleHist}>
              {histOpen
                ? "收起历史 ▴"
                : me
                  ? "会员历史记录（以往复盘 / 一句话手感） ▾"
                  : "会员历史记录（登录后自动存复盘） ▾"}
            </button>
            {histOpen && <HistoryPanel me={me} hist={hist} histErr={histErr} busyId={histBusyId} onRefresh={refreshHist} onDelete={doDeleteHist} />}
          </div>
        </div>
      </section>

      <SiteFooter
        note={
          me
            ? "收工复盘自动存入会员云历史（仅本人可见）；设置保存在本机"
            : "本次块记录只存在内存里，刷新即清空；设置会记住，登录会员可存云历史"
        }
      />

      {/* ===== 右下角阶段提醒气泡 ===== */}
      {toast && (
        <div className="pomo-toast" role="status" aria-live="polite">
          <div className="pomo-toast-icon">{toast.icon}</div>
          <div className="pomo-toast-body">
            <div className="pomo-toast-title">{toast.title}</div>
            <div className="pomo-toast-text">{toast.text}</div>
          </div>
          <button className="pomo-toast-close" onClick={() => setToast(null)} aria-label="关闭提醒">
            ×
          </button>
        </div>
      )}
    </>
  );
}

/* ================================================================
   子组件
   ================================================================ */

function IdleStart({ onStart }: { onStart: () => void }) {
  return (
    <div className="card pomo-idle">
      <div className="pomo-idle-icon">🍅</div>
      <h2>准备好就开打</h2>
      <p className="pomo-idle-desc">专注块 + 强制休息 + 防上头刹车，专治一坐下就起不来。</p>
      <button className="btn-gold pomo-ctrl-btn" onClick={onStart} style={{ marginTop: "1rem" }}>
        开始本次 session →
      </button>
    </div>
  );
}

function BlockNoteEditor({
  block,
  isLatest,
  onChange,
}: {
  block: BlockEntry;
  isLatest?: boolean;
  onChange: (patch: Partial<BlockEntry>) => void;
}) {
  return (
    <div className="pomo-block-edit">
      <div className="pomo-block-edit-head">
        <span className="pomo-block-idx">第 {block.index} 块</span>
        {isLatest && <span className="pomo-block-badge">可编辑</span>}
      </div>

      <div className="pomo-field">
        <label className="pomo-field-label">这块手感</label>
        <div className="pomo-feel-row">
          {FEEL_LEVELS.map((f) => (
            <button
              key={f}
              type="button"
              className={`pomo-feel-btn ${block.feel === f ? "pomo-feel-btn--on" : ""}`}
              style={block.feel === f ? { background: feelTone(f), borderColor: feelTone(f), color: "#0a0a0a" } : undefined}
              onClick={() => onChange({ feel: block.feel === f ? null : f })}
            >
              {feelLabel(f)}
            </button>
          ))}
        </div>
      </div>

      <div className="pomo-field">
        <label className="pomo-field-label">上头指数</label>
        <div className="pomo-tilt-row">
          {([1, 2, 3, 4, 5] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`pomo-tilt-btn ${block.tilt === t ? "pomo-tilt-btn--on" : ""} pomo-tilt-btn--${t}`}
              onClick={() => onChange({ tilt: t })}
              title={TILT_DESC[t - 1]}
            >
              {t}
            </button>
          ))}
          <span className="pomo-tilt-desc">{TILT_DESC[block.tilt - 1]}</span>
        </div>
      </div>

      <div className="pomo-field">
        <label className="pomo-field-label">一句话手感</label>
        <input
          type="text"
          className="pomo-input"
          value={block.note}
          placeholder="比如：连吃两记 bad beat、value 打薄了、心态稳…"
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </div>
    </div>
  );
}

function BlockHistoryRow({ block }: { block: BlockEntry }) {
  return (
    <div className="pomo-hist-row">
      <span className="pomo-hist-idx">#{block.index}</span>
      <span className={`pomo-hist-tilt pomo-tilt-chip--${block.tilt}`}>T{block.tilt}</span>
      <span
        className="pomo-hist-feel"
        style={{ color: block.feel ? feelTone(block.feel) : "#71717a" }}
      >
        {feelLabel(block.feel)}
      </span>
      <span className="pomo-hist-note">{block.note || "（无备注）"}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
  dim = false,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "neutral";
  dim?: boolean;
}) {
  const color = tone === "pos" ? "#22c55e" : tone === "neg" ? "#ef4444" : "#f4f4f5";
  return (
    <div className={`pomo-stat ${dim ? "pomo-stat--dim" : ""}`}>
      <div className="pomo-stat-label">{label}</div>
      <div className="pomo-stat-value" style={{ color: dim ? "#52525b" : color }}>
        {value}
      </div>
    </div>
  );
}

function TiltSpark({ data }: { data: number[] }) {
  // 1..5 画趋势，背景标阈值 tilt=3
  const w = 100;
  const h = 36;
  const pad = 4;
  const n = data.length;
  const x = (i: number) => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - ((v - 1) / 4) * (h - 2 * pad);
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = data[n - 1];
  const lineColor = last >= 4 ? "#ef4444" : last >= 3 ? "#f59e0b" : "#c4a455";
  return (
    <svg className="pomo-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1={pad} y1={y(3)} x2={w - pad} y2={y(3)} stroke="rgba(255,255,255,0.12)" strokeDasharray="2 2" />
      {/* 单点不画折线，避免误导 */}
      {n > 1 && (
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {data.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={n === 1 ? 3 : 2} fill={v >= 4 ? "#ef4444" : "#c4a455"} />
      ))}
    </svg>
  );
}

function SettingsPanel({
  settings,
  notifyPerm,
  onChange,
}: {
  settings: Settings;
  notifyPerm: NotifyStatus;
  onChange: (s: Settings) => void;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const numField = (label: string, key: keyof Settings, min: number, max: number) => (
    <div className="pomo-set-field">
      <label>{label}</label>
      <input
        type="number"
        className="pomo-input"
        min={min}
        max={max}
        value={settings[key] as number}
        onChange={(e) => {
          const v = Math.max(min, Math.min(max, Number(e.target.value) || 0));
          set({ [key]: v } as Partial<Settings>);
        }}
      />
    </div>
  );
  return (
    <div className="card pomo-set-panel">
      <div className="pomo-set-grid">
        {numField("专注时长（分钟）", "focusMin", 5, 180)}
        {numField("短休（分钟）", "shortBreakMin", 1, 60)}
        {numField("长休（分钟）", "longBreakMin", 5, 120)}
        {numField("几块后长休", "cyclesBeforeLongBreak", 2, 12)}
        {numField("本次最多块数（0=不限）", "maxBlocksPerSession", 0, 30)}
      </div>
      <div className="pomo-set-toggles">
        <label className="pomo-toggle">
          <input type="checkbox" checked={settings.soundOn} onChange={(e) => set({ soundOn: e.target.checked })} />
          阶段切换提示音
        </label>
        <label className="pomo-toggle">
          <input type="checkbox" checked={settings.notifyOn} onChange={(e) => set({ notifyOn: e.target.checked })} />
          桌面通知（最小化也能提醒）
        </label>
        <label className="pomo-toggle">
          <input type="checkbox" checked={settings.autoStartNext} onChange={(e) => set({ autoStartNext: e.target.checked })} />
          自动开始下一阶段
        </label>
      </div>
      {settings.notifyOn && notifyPerm === "default" && (
        <p className="pomo-set-note">下次开始计时时会弹出授权询问，点「允许」就能收到桌面通知。</p>
      )}
      {settings.notifyOn && notifyPerm === "denied" && (
        <p className="pomo-set-note pomo-set-note--warn">
          浏览器已拦截通知，最小化后只剩提示音和页面内气泡。想恢复：点地址栏左侧 🔒 → 网站设置 → 通知 → 允许，然后刷新页面。
        </p>
      )}
      {settings.notifyOn && notifyPerm === "unsupported" && (
        <p className="pomo-set-note">当前浏览器不支持桌面通知，页面最小化后仅剩提示音。</p>
      )}
      <p className="pomo-set-note">改设置只影响「之后」开始的阶段，不会打断正在跑的计时。</p>
    </div>
  );
}

function SummaryCard({
  ended,
  blocks,
  tally,
  realElapsedSec,
  onRestart,
  saveState,
  onRetrySave,
}: {
  ended: { focusMin: number; reason: string };
  blocks: BlockEntry[];
  tally: ReturnType<typeof tallyBlocks>;
  realElapsedSec: number;
  onRestart: () => void;
  saveState: null | { state: "saving" | "saved" | "error"; rec: PomoRecordInput };
  onRetrySave: () => void;
}) {
  const verdict =
    tally.avgTilt == null
      ? "没有填上头数据"
      : tally.avgTilt <= 2
      ? "心态稳，状态在线"
      : tally.avgTilt <= 3.5
      ? "有点起伏，注意节奏"
      : "上头了，建议立刻离桌";
  const totalFeel = Object.values(tally.feelCounts).reduce((a, b) => a + b, 0);
  return (
    <div className="card pomo-summary">
      <p className="section-label">本次复盘</p>
      <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2.25rem)", fontWeight: 800, marginBottom: "0.25rem" }}>
        打完了，收工。
      </h2>
      <p className="pomo-summary-reason">{ended.reason}</p>

      <div className="pomo-sum-grid">
        <SumStat label="专注块数" value={String(tally.completedBlocks)} />
        <SumStat label="专注时长" value={fmtMin(ended.focusMin)} />
        <SumStat label="实际耗时" value={fmtMin(realElapsedSec / 60)} />
        <SumStat
          label="平均上头"
          value={tally.avgTilt != null ? tally.avgTilt.toFixed(2) + " / 5" : "—"}
          tone={tally.avgTilt != null && tally.avgTilt >= 3.5 ? "neg" : "neutral"}
        />
      </div>

      {/* 手感分布迷你条 */}
      {totalFeel > 0 && (
        <div className="pomo-feel-bar-wrap">
          <div className="pomo-trend-label">手感分布</div>
          <div className="pomo-feel-bar">
            {FEEL_LEVELS.map((f) => {
              const cnt = tally.feelCounts[f];
              if (cnt === 0) return null;
              return (
                <div
                  key={f}
                  className="pomo-feel-seg"
                  style={{ width: `${(cnt / totalFeel) * 100}%`, background: feelTone(f) }}
                  title={`${feelLabel(f)} ×${cnt}`}
                />
              );
            })}
          </div>
          <div className="pomo-feel-legend">
            {FEEL_LEVELS.map((f) => {
              const cnt = tally.feelCounts[f];
              if (cnt === 0) return null;
              return (
                <span key={f} className="pomo-feel-legend-item">
                  <span className="pomo-feel-dot" style={{ background: feelTone(f) }} />
                  {feelLabel(f)} {cnt}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="pomo-verdict">
        <span className="pomo-verdict-label">系统判语</span>
        <span className="pomo-verdict-text">{verdict}</span>
      </div>

      {blocks.length > 0 && (
        <div className="pomo-sum-trend">
          <div className="pomo-trend-label">上头趋势</div>
          <TiltSpark data={tally.tiltSeries} />
        </div>
      )}

      <button className="btn-gold pomo-ctrl-btn" style={{ marginTop: "1.5rem" }} onClick={onRestart}>
        重新开一场
      </button>
      {saveState && (
        <div className="pomo-save-state" role="status">
          {saveState.state === "saving" && <span>☁️ 正在存入会员云历史…</span>}
          {saveState.state === "saved" && (
            <span className="is-ok">✓ 已存入会员云历史，可在下方「会员历史记录」回看</span>
          )}
          {saveState.state === "error" && (
            <>
              <span className="is-err">存云失败</span>
              <button type="button" className="pomo-save-retry" onClick={onRetrySave}>
                重试
              </button>
            </>
          )}
        </div>
      )}
      <p className="pomo-summary-foot">
        {saveState ? "逐块明细（含一句话手感）已随复盘入云，仅本人可见。" : "本次数据不会保存，刷新或重开即清空。"}
      </p>
    </div>
  );
}

function SumStat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "pos" | "neg" | "neutral" }) {
  const color = tone === "pos" ? "#22c55e" : tone === "neg" ? "#ef4444" : "#f4f4f5";
  return (
    <div className="pomo-sum-stat">
      <div className="pomo-sum-label">{label}</div>
      <div className="pomo-sum-value" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

/* ================================================================
   会员云历史面板
   ================================================================ */

function HistoryPanel({
  me,
  hist,
  histErr,
  busyId,
  onRefresh,
  onDelete,
}: {
  me: MeUser | null;
  hist: PomoRecord[] | null;
  histErr: string | null;
  busyId: string | null;
  onRefresh: () => void;
  onDelete: (id: string) => void;
}) {
  if (!me) {
    return (
      <div className="card pomo-hist-panel pomo-hist-login">
        登录会员后，每次收工复盘会自动存到这里：逐块的一句话手感、上头指数、手感分布随时回看。
        点右上角「会员登录」即可，数据仅本人可见。
      </div>
    );
  }

  /* 聚合：累计复盘次数 / 总块数 / 总专注时长 / 加权平均上头 */
  let totalBlocks = 0;
  let totalFocusMin = 0;
  let tiltWeighted = 0;
  let tiltN = 0;
  for (const r of hist ?? []) {
    totalBlocks += r.blocks;
    totalFocusMin += r.focusMin;
    if (r.avgTilt != null && r.blocks > 0) {
      tiltWeighted += r.avgTilt * r.blocks;
      tiltN += r.blocks;
    }
  }
  const overallTilt = tiltN > 0 ? tiltWeighted / tiltN : null;

  return (
    <div className="card pomo-hist-panel">
      <div className="pomo-hist-head">
        <span className="pomo-hist-user">{me.username}</span>
        <span className="pomo-panel-sub">仅本人可见 · 最多存最近 200 次</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="pomo-hist-refresh" onClick={onRefresh}>
          刷新
        </button>
      </div>

      {histErr && (
        <p className="pomo-empty">
          {histErr}{" "}
          <button type="button" className="pomo-hist-refresh" onClick={onRefresh}>
            重试
          </button>
        </p>
      )}
      {hist === null && !histErr && <p className="pomo-empty">加载中…</p>}
      {hist !== null && hist.length === 0 && (
        <p className="pomo-empty">还没有历史复盘。打完一次收工（「结束本次」），这里就会有记录。</p>
      )}

      {hist !== null && hist.length > 0 && (
        <>
          <div className="pomo-hist-stats">
            <span>
              累计 <strong>{hist.length}</strong> 次复盘
            </span>
            <span>
              <strong>{totalBlocks}</strong> 块专注
            </span>
            <span>
              专注时长 <strong>{fmtMin(totalFocusMin)}</strong>
            </span>
            <span>
              平均上头{" "}
              <strong style={{ color: overallTilt != null && overallTilt >= 3.5 ? "#ef4444" : "#f4f4f5" }}>
                {overallTilt != null ? overallTilt.toFixed(1) : "—"}
              </strong>
            </span>
          </div>
          <div>
            {hist.map((r) => (
              <HistRow key={r.id} rec={r} busy={busyId === r.id} onDelete={() => onDelete(r.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function HistRow({ rec, busy, onDelete }: { rec: PomoRecord; busy: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  // 两步确认：第一次点变成「确认删除？」，再点才真删
  const [confirmDel, setConfirmDel] = useState(false);
  const tiltLevel = rec.avgTilt != null ? Math.min(5, Math.max(1, Math.round(rec.avgTilt))) : null;
  const feelParts = FEEL_LEVELS.filter((f) => (rec.feelCounts[f] ?? 0) > 0);
  return (
    <div className="pomo-hist-item">
      <div className="pomo-hist-line">
        <button
          type="button"
          className="pomo-hist-expand"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="pomo-hist-date">{fmtDate(rec.endedAt)}</span>
        <span className="pomo-hist-kpi">
          {rec.blocks} 块 · {fmtMin(rec.focusMin)} · 实耗 {fmtMin(rec.elapsedSec / 60)}
        </span>
        {tiltLevel != null && (
          <span className={`pomo-hist-tilt pomo-tilt-chip--${tiltLevel}`}>上头 {rec.avgTilt!.toFixed(1)}</span>
        )}
        {feelParts.length > 0 && (
          <span className="pomo-hist-feels">
            {feelParts.map((f) => (
              <span key={f} className="pomo-hist-feel-dot" title={feelLabel(f)}>
                <i style={{ background: feelTone(f) }} />
                {(rec.feelCounts[f] ?? 0)}
              </span>
            ))}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={`pomo-hist-del${confirmDel ? " is-confirm" : ""}`}
          disabled={busy}
          onClick={() => {
            if (busy) return;
            if (confirmDel) {
              onDelete();
              setConfirmDel(false);
            } else {
              setConfirmDel(true);
            }
          }}
        >
          {busy ? "删除中…" : confirmDel ? "确认删除？" : "删除"}
        </button>
      </div>
      {open && (
        <div className="pomo-hist-detail">
          <div className="pomo-hist-reason">结束原因：{rec.reason || "—"}</div>
          {rec.blocksData.length === 0 ? (
            <p className="pomo-empty">这条复盘没有逐块明细（可能来自旧数据）。</p>
          ) : (
            [...rec.blocksData]
              .sort((a, b) => a.index - b.index)
              .map((b) => <BlockHistoryRow key={`${rec.id}-${b.index}`} block={b} />)
          )}
        </div>
      )}
    </div>
  );
}
