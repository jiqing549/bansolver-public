/* ================================================================
   pomodoro.ts — 扑克番茄钟（单次 session 版）
   纯逻辑层，不依赖 React。只保存「设置」到 localStorage，
   当前 session 的数据全在内存里（刷新即清空，符合工具定位）。
   ================================================================ */

/** 这一块的自评感觉：粗粒度，承认牌手用 HUD 记账，这里只抓心态 */
export type FeelLevel = "big_win" | "small_win" | "even" | "small_loss" | "big_loss";

export const FEEL_LEVELS: FeelLevel[] = ["big_win", "small_win", "even", "small_loss", "big_loss"];

const FEEL_LABELS: Record<FeelLevel, string> = {
  big_win: "大赢",
  small_win: "小赢",
  even: "持平",
  small_loss: "小亏",
  big_loss: "大亏",
};

/** 返回中文标签 */
export function feelLabel(feel: FeelLevel | null): string {
  return feel ? FEEL_LABELS[feel] : "未选";
}

/** 颜色档：用于按钮和分布条 */
export function feelTone(feel: FeelLevel): string {
  return (
    {
      big_win: "#22c55e",
      small_win: "#84cc16",
      even: "#a1a1aa",
      small_loss: "#f97316",
      big_loss: "#ef4444",
    } as const
  )[feel];
}

/** 一个专注块结束后落下的「块笔记」 */
export interface BlockEntry {
  id: string;
  index: number; // 本次 session 第几块（从 1 开始）
  ts: number;
  tilt: 1 | 2 | 3 | 4 | 5; // 这块的上头指数：1=佛系 5=爆缸
  feel: FeelLevel | null; // 这块的自评感觉，默认未选
  note: string; // 一句话手感记录
}

/** 判断一块是否仍是「未填写」默认状态（tilt 默认 3 + feel 未选 + note 空） */
export function isBlockBlank(b: BlockEntry): boolean {
  return b.tilt === 3 && b.feel === null && b.note.trim() === "";
}

/** 番茄钟运行时配置 */
export interface Settings {
  focusMin: number; // 单轮专注时长
  shortBreakMin: number; // 短休
  longBreakMin: number; // 长休
  cyclesBeforeLongBreak: number; // 几轮后长休（默认 4）
  maxBlocksPerSession: number; // 本次 session 最多打几块就强制停（防上头，0=不限制）
  soundOn: boolean; // 提示音
  autoStartNext: boolean; // 自动开始下一阶段
  notifyOn: boolean; // 桌面通知（页面最小化也能收到提醒）
}

/** 默认配置 */
export const DEFAULT_SETTINGS: Settings = {
  focusMin: 40,
  shortBreakMin: 10,
  longBreakMin: 30,
  cyclesBeforeLongBreak: 4,
  maxBlocksPerSession: 2,
  soundOn: true,
  autoStartNext: false,
  notifyOn: true,
};

const SETTINGS_KEY = "bansolver_pomodoro_settings_v1";

/* ---------------------------------------------------------------
   存储层（SSR 安全：只在 window 存在时读写）
   --------------------------------------------------------------- */
export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    // 兼容旧版本可能残留的 currency 字段：剔除后合并
    if (parsed && typeof parsed === "object") delete (parsed as { currency?: unknown }).currency;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 配额或禁用，静默 */
  }
}

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------
   单次 session 内的聚合（纯内存数据）
   --------------------------------------------------------------- */
export interface SessionTally {
  completedBlocks: number;
  feelCounts: Record<FeelLevel, number>; // 各感觉档的计数
  avgTilt: number | null;
  maxTilt: number | null;
  tiltSeries: number[]; // 每块的 tilt，按时间序（画趋势用）
}

function emptyFeelCounts(): Record<FeelLevel, number> {
  return { big_win: 0, small_win: 0, even: 0, small_loss: 0, big_loss: 0 };
}

export function tallyBlocks(blocks: BlockEntry[]): SessionTally {
  const n = blocks.length;
  const tilts = blocks.map((b) => b.tilt);
  const feelCounts = emptyFeelCounts();
  for (const b of blocks) {
    if (b.feel) feelCounts[b.feel]++;
  }
  return {
    completedBlocks: n,
    feelCounts,
    avgTilt: n ? tilts.reduce((a, b) => a + b, 0) / n : null,
    maxTilt: n ? Math.max(...tilts) : null,
    tiltSeries: tilts,
  };
}

/** 手感分布的紧凑文字：如 "2赢 1平 1亏" */
export function feelSummary(counts: Record<FeelLevel, number>): string {
  const win = counts.big_win + counts.small_win;
  const loss = counts.big_loss + counts.small_loss;
  const even = counts.even;
  const parts: string[] = [];
  if (win) parts.push(`${win}赢`);
  if (even) parts.push(`${even}平`);
  if (loss) parts.push(`${loss}亏`);
  return parts.length ? parts.join(" ") : "—";
}

/* ---------------------------------------------------------------
   提示音（Web Audio，无需音频文件）
   --------------------------------------------------------------- */
export function beep(kind: "focus-end" | "break-end"): void {
  if (typeof window === "undefined") return;
  try {
    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const notes = kind === "focus-end" ? [880, 1100] : [660, 880, 1100];
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ac.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
    setTimeout(() => ac.close(), notes.length * 200 + 300);
  } catch {
    /* 静默 */
  }
}

/* ---------------------------------------------------------------
   桌面通知：页面最小化/切到别的标签页也能收到提醒
   需要用户授权；浏览器只允许在用户手势（点击）里请求授权
   --------------------------------------------------------------- */
export type NotifyStatus = NotificationPermission | "unsupported";

/** 当前通知权限状态；浏览器不支持时返回 "unsupported" */
export function notifyStatus(): NotifyStatus {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** 发一条桌面通知（已授权才发，未授权/不支持静默跳过） */
export function notify(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  try {
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body, lang: "zh-CN" });
    // 点通知把浏览器弹回前台
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {
        /* 静默 */
      }
    };
  } catch {
    /* 静默 */
  }
}

/** 请求通知授权（需在用户手势里调用）；结果通过 onDone 回传 */
export function requestNotifyPermission(onDone?: (perm: NotificationPermission) => void): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "default") {
    onDone?.(Notification.permission);
    return;
  }
  try {
    const p = Notification.requestPermission();
    // 老 Safari 同步返回 undefined，旧式回调也兼容
    if (p && typeof p.then === "function") {
      p.then((perm) => onDone?.(perm)).catch(() => {});
    }
  } catch {
    /* 授权请求被拒绝或抛出，静默（不影响计时） */
  }
}

/* ---------------------------------------------------------------
   格式化辅助
   --------------------------------------------------------------- */
export function fmtMin(min: number): string {
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** mm:ss 倒计时格式 */
export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
