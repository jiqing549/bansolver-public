"use client";

/* ================================================================
   Ban2Note — GGPoker 牌谱统计仪表盘（旗舰功能）
   ================================================================
   布局：左操作面板（380px 常驻）+ 右弹性结果区；
   ≥1900px 宽屏时最左留白处出现荣耀致谢滚动栏（CreditsRail，名单见 credits.ts）
   右侧四个 tab（rightPage state）：
     "data"    数据总览  — 4 条盈利曲线 + 统计卡片三行（盈利$ / 曲线终点三卡+百手 / 频率指标）+ 位置行（水后百手对照 GTO/PRO 基准）
     "luck"    运气如何  — 起手牌频率 + 成牌运气 + 波动预估卡片
     "profit"  盈利矩阵  — 13×13 起手牌净盈利矩阵 + 组合详情（ProfitMatrixPanel）
     "handlog" 查看牌谱  — 逐手牌谱表 + 单手回放弹窗（HandLogPanel）
     "detail"  详细数据  — HM3/PT4 风格 stats（VPIP/PFR/3Bet/CBet... 按街+IP/OOP 拆分）
     "gto"     对比GTO  — 逐位置 PFR 范围 vs GTO 基准，delta 矩阵（前端计算）

   筛选数据流：
     parsedHands（原始解析）→ 按 stakes/position 过滤 → computeStats/computeLuckStats
     重算 → 4 条曲线（preRake/postRake/SD/NSD）+ stats 卡片

   支持上传 .txt / .zip / 嵌套 zip / 文件夹，自动检测玩家名、去重、备份到 /api/backup。
   ================================================================ */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import CloudPanel from "./CloudPanel";
import { type MeUser, fetchMe, uploadHands } from "./cloud";
// 防泄漏边界：本页面禁止 import "@/lib/handHistory"（解析器核心只活在服务端）。
// 统计引擎/共享类型/EV 求解走 hhStats / hhTypes / hhEv。
import { computeStats, computeLuckStats, type LuckStats } from "@/lib/hhStats";
import type { ParsedHand, SessionStats } from "@/lib/hhTypes";
import { solveEvPlan, type EvPlan } from "@/lib/hhEv";
import { parseHandsChunk } from "@/lib/handHistory";
import { deriveFromSession, simulate, drawdownPercentile, sortResultsByProfit, drawVarianceHistogram, winRateConfidenceInterval } from "@/lib/variance";
import JSZip from "jszip";
import Navbar from "@/app/components/Navbar";
import CreditsRail from "./CreditsRail";
import GtoComparePanel from "./GtoComparePanel";
import ProfitMatrixPanel from "./ProfitMatrixPanel";
import HandLogPanel from "./HandLogPanel";
import ShareModal, { type SharePosCard } from "./ShareModal";
import "./ban2note.css";

const COLOR_PRE_RAKE = "#16a34a";
const COLOR_NET = "#a855f7";
const COLOR_EV = "#f59e0b";    // All-in EV — amber
const MAX_ZIP_DEPTH = 10;
// 超过该文本量（约 30MB）的上传跳过服务器备份：dedupedText 拼接 + 请求体都不可承受
const BACKUP_MAX_CHARS = 30_000_000;

// 筛选 chip 预设选项
const STAKE_FILTERS = ["NL2", "NL5", "NL10", "NL25", "NL50", "NL100", "NL200", "NL500", "NL1000"];
const POSITION_FILTERS = ["BB", "SB", "BTN", "CO", "HJ", "MP", "UTG+2", "UTG+1", "UTG"];
type DateRange = "today" | "week" | "month" | "year";
const DATE_FILTERS: { key: DateRange; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "year", label: "今年" },
];

// 给定 DateRange，返回该范围起点的时间戳（含）；null 表示不限。
// 自然周：本周一 0 点（GG 牌谱用户习惯周一为一周起点）。
function dateRangeStart(range: DateRange): number | null {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 今天 0 点
  if (range === "today") return start.getTime();
  if (range === "week") {
    // getDay(): 0=周日 … 6=周六；周一为起点
    const dayIdx = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - dayIdx);
    return start.getTime();
  }
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return new Date(now.getFullYear(), 0, 1).getTime(); // year
}

// 把牌谱日期（"2026/06/08 15:10:59"）转成时间戳；解析失败返回 NaN。
function handDateToTs(date: string): number {
  if (!date) return NaN;
  return Date.parse(date.replace(/\//g, "-"));
}

// 把 stakes 字符串（如 "$0.01/$0.02"）映射成 NL 级别标签（如 "NL2"）
function stakesToNL(stakes: string): string | null {
  // 取 BB（"/" 后的值），NL 级别 = BB × 100
  const bbStr = stakes.split("/")[1];
  if (!bbStr) return null;
  const bb = parseFloat(bbStr.replace(/[^0-9.]/g, ""));
  if (!isFinite(bb) || bb <= 0) return null;
  const nl = Math.round(bb * 100);
  return `NL${nl}`;
}

function isHandHistoryFile(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith(".txt") || lower.endsWith(".zip");
}

// 逐文本流式回调：边解压边交给 onText 消化，避免把整个 zip 的文本攒成一个
// 数组（几十万手的会话里那一攒就是几百 MB，是压垮标签页的元凶之一）
async function extractTextsFromZip(
  zip: JSZip,
  onText: (text: string) => Promise<void> | void,
  depth = 0,
  onProgress?: (path: string) => void,
): Promise<void> {
  if (depth > MAX_ZIP_DEPTH) return;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const lower = path.toLowerCase();
    if (lower.endsWith(".txt")) {
      await onText(await entry.async("text"));
    } else if (lower.endsWith(".zip")) {
      onProgress?.(`正在解压 ${path}…`);
      const nested = await JSZip.loadAsync(await entry.async("arraybuffer"));
      await extractTextsFromZip(nested, onText, depth + 1, onProgress);
    }
  }
}

async function readHandHistoryFile(
  file: File,
  onText: (text: string) => Promise<void> | void,
  onProgress?: (path: string) => void,
): Promise<void> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".txt")) {
    await onText(await file.text());
    return;
  }
  if (lower.endsWith(".zip")) {
    onProgress?.(`正在解压 ${file.name}…`);
    const zip = await JSZip.loadAsync(file);
    await extractTextsFromZip(zip, onText, 0, onProgress);
  }
}

// 后台线程两阶段解析：阶段一快速出全部手牌（EV 只收集计划），阶段二 Worker
// 内逐批补算 EV。主线程在阶段一结束即可渲染基础数据与非 EV 曲线，EV 线随
// onEvBatch 渐进点亮。Worker 构造失败（老浏览器/环境不支持）时回退主线程
// 同步解析——同一套解析器一次性算全（含 EV），只是无进度。
export type EvBatchMsg = {
  results: { id: string; allInEV: number | null }[];
  solved: number;
  total: number;
};
type ParseSessionHandlers = {
  onProgress: (p: { scanned: number; total: number; kept: number }) => void;
  onHands: (r: { hands: ParsedHand[]; duplicateHands: number; evTotal: number }) => void;
  onEvBatch: (b: EvBatchMsg) => void;
  onEvDone: () => void;
  onError: (message: string) => void;
};
type ParseSession = {
  postText: (text: string) => void;
  finish: () => void;
  terminate: () => void;
  /** 全部文本的阶段一完成（每文本一包 hands 均已送达） */
  allTextsParsed: Promise<void>;
};
function startParseSession(h: ParseSessionHandlers): ParseSession {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./parseWorker.ts", import.meta.url));
  } catch {
    worker = null;
  }
  if (!worker) {
    // 回退：主线程一次性本地解析（含 EV，语义与旧版一致；无进度回报）
    let resolveAll: () => void = () => {};
    const allTextsParsed = new Promise<void>((r) => { resolveAll = r; });
    return {
      postText: (text) => {
        void (async () => {
          try {
            const evOut = { plans: [] as EvPlan[] };
            const { hands, duplicateHands } = parseHandsChunk(text, "Hero", evOut);
            const byId = new Map(hands.map((x) => [x.id, x]));
            for (const p of evOut.plans) {
              const h = byId.get(p.handId);
              if (h) h.allInEV = solveEvPlan(p) ?? h.allInEV;
            }
            h.onHands({ hands, duplicateHands, evTotal: 0 });
          } catch (err) {
            h.onError(err instanceof Error ? err.message : String(err));
          }
        })();
      },
      finish: () => resolveAll(),
      terminate: () => {},
      allTextsParsed,
    };
  }
  let sent = 0;
  let parsed = 0;
  let finished = false;
  let resolveAll: () => void = () => {};
  const allTextsParsed = new Promise<void>((r) => { resolveAll = r; });
  const maybeResolve = () => {
    if (finished && parsed >= sent) resolveAll();
  };
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as
      | { type: "progress"; totalChunks: number; scannedChunks: number; keptHands: number }
      | { type: "hands"; hands: ParsedHand[]; duplicateHands: number; evTotal: number }
      | { type: "ev"; results: { id: string; allInEV: number | null }[]; solved: number; total: number }
      | { type: "evDone" }
      | { type: "error"; message: string };
    if (m.type === "progress") {
      h.onProgress({ scanned: m.scannedChunks, total: m.totalChunks, kept: m.keptHands });
    } else if (m.type === "hands") {
      parsed++;
      h.onHands(m);
      maybeResolve();
    } else if (m.type === "ev") {
      h.onEvBatch(m);
    } else if (m.type === "evDone") {
      h.onEvDone();
    } else if (m.type === "error") {
      worker!.terminate();
      worker = null;
      h.onError(m.message || "解析线程异常");
      resolveAll();
    }
  };
  worker.onerror = (ev) => {
    worker?.terminate();
    worker = null;
    h.onError(ev.message || "解析线程异常");
    resolveAll();
  };
  return {
    postText: (text) => {
      sent++;
      // Worker 已因错误终止时不再发送：旧代码强解引用 null 抛 TypeError，
      // 剩余文件的循环被 catch 吞掉，worker 报的具体错误（如内存不足）被
      // 「解析失败」兜底文案覆盖（2026-11-03 审查 P3）
      if (!worker) return;
      worker.postMessage({ type: "parse", text });
    },
    finish: () => {
      finished = true;
      if (!worker) {
        maybeResolve();
        return;
      }
      worker.postMessage({ type: "finish" });
      maybeResolve();
    },
    terminate: () => {
      worker?.terminate();
      worker = null;
      resolveAll();
    },
    allTextsParsed,
  };
}

// Downsample data to pixel columns for performance (always includes first & last point)
function downsample(data: { hand: number; profit: number }[], targetPoints: number) {
  if (data.length <= targetPoints) return { sampled: data, indices: data.map((_, i) => i) };
  const sampled: { hand: number; profit: number }[] = [];
  const indices: number[] = [];
  const last = data.length - 1;
  for (let i = 0; i < targetPoints; i++) {
    const idx = i === targetPoints - 1 ? last : Math.round((i / (targetPoints - 1)) * last);
    if (indices.length > 0 && idx === indices[indices.length - 1]) continue;
    sampled.push(data[idx]);
    indices.push(idx);
  }
  if (indices[indices.length - 1] !== last) {
    sampled.push(data[last]);
    indices.push(last);
  }
  return { sampled, indices };
}

// 计算「漂亮刻度」：让 Y 轴标签落在规整数值上，且 0 必然是一个刻度点
function niceTicks(min: number, max: number, targetTicks = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  // 0 必须在范围内，作为基准刻度
  min = Math.min(min, 0);
  max = Math.max(max, 0);
  const span = max - min;
  const rawStep = span / (targetTicks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  step *= mag;
  // 从 0 向两侧扩展，首尾刻度必须严格包住数据范围（max 向上取整到 step 倍数，min 向下取整）
  const topTick = Math.ceil(max / step) * step;
  const bottomTick = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = bottomTick; v <= topTick; v += step) ticks.push(v);
  return ticks.sort((a, b) => a - b);
}

// 曲线绘图区边距：drawChart 与鼠标事件共用，改一处两处同步
// （历史 bug：终点标签把 right 24→64，但鼠标 idxAt 还写死 24，导致 hover 偏移）
const CHART_PAD = { top: 24, right: 64, bottom: 44, left: 56 };

// 曲线可见性：图例 checkbox 控制，隐藏的线不参与 Y 轴范围计算（主线不被分解线压扁）
type CurveVis = { pre: boolean; net: boolean; ev: boolean; sd: boolean; nsd: boolean };
const CURVE_ALL_ON: CurveVis = { pre: true, net: true, ev: true, sd: true, nsd: true };

/**
 * 盈利曲线绘制。4 条线含义：
 *   data    水前盈亏（含底池、未扣抽水）—— 亮绿 #22c55e
 *   netData 水后盈亏（扣抽水后真实所得）—— 紫色 #a855f7（COLOR_NET）
 *   sdData  摊牌赢额（showdown 线）—— 蓝色 #3b82f6
 *   nsdData 非摊牌赢额（non-showdown 线）—— 红色 #ef4444
 *
 * 交互：
 *   crossIdx  点击锁定的索引（白色实线十字 + 固定 tooltip），-1 = 无锁定
 *   hoverIdx  鼠标悬停的索引（金色虚线十字 + 跟随 tooltip），-1 = 无悬停
 *   两者可并存：hover 实时显示，点击锁定保留。
 */
function drawChart(canvas: HTMLCanvasElement, data: { hand: number; profit: number }[], netData: { hand: number; profit: number }[], sdData: { hand: number; profit: number }[], nsdData: { hand: number; profit: number }[], evData: { hand: number; profit: number }[], crossIdx = -1, hoverIdx = -1, vis: CurveVis = CURVE_ALL_ON) {
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  // clientWidth/Height reflect CSS layout size; getBoundingClientRect can be stale during resize
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W <= 0 || H <= 0) return;

  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (data.length < 2) { ctx.fillStyle = "#9ca3af"; ctx.font = "14px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("需要至少 2 手牌数据", W / 2, H / 2); return; }

  const pad = CHART_PAD;
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // Find min/max across visible datasets only（隐藏的线不撑 Y 轴）；
  // 全部隐藏时兜底显示水前线，避免空图
  const visArrs: { hand: number; profit: number }[][] = [];
  if (vis.pre) visArrs.push(data);
  if (vis.net) visArrs.push(netData);
  if (vis.sd) visArrs.push(sdData);
  if (vis.nsd) visArrs.push(nsdData);
  if (vis.ev) visArrs.push(evData);
  if (visArrs.length === 0) visArrs.push(data);
  let minVal = Infinity, maxVal = -Infinity;
  for (const arr of visArrs) {
    for (const d of arr) { minVal = Math.min(minVal, d.profit); maxVal = Math.max(maxVal, d.profit); }
  }
  if (!isFinite(minVal)) { minVal = -10; maxVal = 10; }
  // 用「漂亮刻度」确定 Y 轴：0 必然是一个刻度，标签落在规整数值上
  const yTicks = niceTicks(minVal, maxVal, 5);
  minVal = yTicks[0];
  maxVal = yTicks[yTicks.length - 1];

  const toX = (i: number) => pad.left + (i / (data.length - 1 || 1)) * plotW;
  const toY = (v: number) => pad.top + plotH - ((v - minVal) / (maxVal - minVal || 1)) * plotH;

  // Background
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (const val of yTicks) {
    const y = toY(val);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }

  // Zero line
  const zeroY = toY(0);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(W - pad.right, zeroY); ctx.stroke();
  ctx.setLineDash([]);

  // Downsample for performance
  const { sampled, indices } = downsample(data, Math.min(data.length, plotW * 2));

  // NSD line (red - non-showdown)
  if (vis.nsd) {
  const nsdSampled = downsample(nsdData, Math.min(nsdData.length, plotW * 2));
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < nsdSampled.sampled.length; i++) {
    const x = toX(nsdSampled.indices[i]);
    const y = toY(nsdSampled.sampled[i].profit);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  }

  // SD line (blue - showdown)
  if (vis.sd) {
  const sdSampled = downsample(sdData, Math.min(sdData.length, plotW * 2));
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < sdSampled.sampled.length; i++) {
    const x = toX(sdSampled.indices[i]);
    const y = toY(sdSampled.sampled[i].profit);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  }

  // Net line (green - pre-rake total)
  if (vis.pre) {
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i < sampled.length; i++) {
    const x = toX(indices[i]);
    const y = toY(sampled[i].profit);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  }

  // Post-rake line (purple)
  if (vis.net) {
  const netSampled = downsample(netData, Math.min(netData.length, plotW * 2));
  ctx.strokeStyle = COLOR_NET;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < netSampled.sampled.length; i++) {
    const x = toX(netSampled.indices[i]);
    const y = toY(netSampled.sampled[i].profit);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  }

  // EV line (amber — All-in Equity Adjusted)
  if (vis.ev) {
  const evSampled = downsample(evData, Math.min(evData.length, plotW * 2));
  ctx.strokeStyle = COLOR_EV;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i < evSampled.sampled.length; i++) {
    const x = toX(evSampled.indices[i]);
    const y = toY(evSampled.sampled[i].profit);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  }

  // 终点数值标签：每条可见线在最右端标注最终盈亏
  const endLabelX = pad.left + plotW + 6;
  const endEntries = [
    ...(vis.pre ? [{ label: fmtBB(data[data.length - 1].profit), color: "#22c55e", y: toY(data[data.length - 1].profit) }] : []),
    ...(vis.net ? [{ label: fmtBB(netData[netData.length - 1].profit), color: COLOR_NET, y: toY(netData[netData.length - 1].profit) }] : []),
    ...(vis.sd ? [{ label: fmtBB(sdData[sdData.length - 1].profit), color: "#3b82f6", y: toY(sdData[sdData.length - 1].profit) }] : []),
    ...(vis.nsd ? [{ label: fmtBB(nsdData[nsdData.length - 1].profit), color: "#ef4444", y: toY(nsdData[nsdData.length - 1].profit) }] : []),
    ...(vis.ev ? [{ label: fmtBB(evData[evData.length - 1].profit), color: COLOR_EV, y: toY(evData[evData.length - 1].profit) }] : []),
  ].sort((a, b) => a.y - b.y);
  // 防 y 轴重叠：相邻标签间距不足 14px 时向下推开
  const minGap = 14;
  for (let i = 1; i < endEntries.length; i++) {
    if (endEntries[i].y - endEntries[i - 1].y < minGap) {
      endEntries[i].y = endEntries[i - 1].y + minGap;
    }
  }
  ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const e of endEntries) {
    ctx.fillStyle = e.color;
    ctx.fillText(e.label, endLabelX, e.y);
  }
  ctx.textBaseline = "alphabetic";   // 重置：Y/X 轴标签用默认 baseline + 手动 +4 偏移

  // Axes
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(W - pad.right, pad.top + plotH);
  ctx.stroke();

  const axisFont = "12px ui-sans-serif, system-ui, sans-serif";
  const labelColor = "#9ca3af";

  // Y labels — 用漂亮刻度，0 必然出现
  ctx.fillStyle = labelColor;
  ctx.font = axisFont;
  ctx.textAlign = "right";
  for (const val of yTicks) {
    const y = pad.top + plotH - ((val - minVal) / (maxVal - minVal || 1)) * plotH + 4;
    const label = Math.abs(val) >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Math.round(val)}`;
    ctx.fillText(label, pad.left - 8, y);
  }

  // X labels
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const x = pad.left + (plotW / 4) * i;
    const hand = Math.round((i / 4) * data.length);
    const label = hand >= 10000 ? `${(hand / 1000).toFixed(0)}k` : `${hand}`;
    ctx.fillText(label, x, pad.top + plotH + 20);
  }
  ctx.fillText("手数", pad.left + plotW / 2, pad.top + plotH + 36);

  // 图例已移到 canvas 下方 DOM（带勾选框，见 .curve-legend），canvas 内不再绘制

  // 固定 tooltip（点击锁定）—— 实线十字线
  if (crossIdx >= 0 && crossIdx < data.length) {
    drawChartTooltip(
      ctx,
      toX(crossIdx),
      pad,
      plotW,
      plotH,
      W,
      data[crossIdx].hand,
      data[crossIdx].profit,
      netData[crossIdx].profit,
      sdData[crossIdx].profit,
      nsdData[crossIdx].profit,
      evData[crossIdx].profit,
      false,
      vis,
    );
  }

  // 跟随鼠标的 tooltip（hover，优先级高于固定）—— 半透明十字线
  if (hoverIdx >= 0 && hoverIdx < data.length) {
    drawChartTooltip(
      ctx,
      toX(hoverIdx),
      pad,
      plotW,
      plotH,
      W,
      data[hoverIdx].hand,
      data[hoverIdx].profit,
      netData[hoverIdx].profit,
      sdData[hoverIdx].profit,
      nsdData[hoverIdx].profit,
      evData[hoverIdx].profit,
      true,
      vis,
    );
  }
}

function fmtBB(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} BB`;
}

function drawChartTooltip(
  ctx: CanvasRenderingContext2D,
  x: number,
  pad: { top: number; right: number; bottom: number; left: number },
  plotW: number,
  plotH: number,
  W: number,
  hand: number,
  preBB: number,
  netBB: number,
  sdBB: number,
  nsdBB: number,
  evBB: number,
  hover = false,
  vis: CurveVis = CURVE_ALL_ON,
) {
  ctx.strokeStyle = hover ? "rgba(168,139,70,0.5)" : "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  if (hover) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, pad.top);
  ctx.lineTo(x, pad.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  const rows: { label: string; value: string; color: string }[] = [
    ...(vis.pre ? [{ label: "水前", value: fmtBB(preBB), color: "#22c55e" }] : []),
    ...(vis.net ? [{ label: "水后", value: fmtBB(netBB), color: COLOR_NET }] : []),
    ...(vis.ev ? [{ label: "EV", value: fmtBB(evBB), color: COLOR_EV }] : []),
    ...(vis.sd ? [{ label: "摊牌", value: fmtBB(sdBB), color: "#3b82f6" }] : []),
    ...(vis.nsd ? [{ label: "非摊牌", value: fmtBB(nsdBB), color: "#ef4444" }] : []),
  ];

  const titleFont = "600 12px ui-sans-serif, system-ui, sans-serif";
  const rowLabelFont = "11px ui-sans-serif, system-ui, sans-serif";
  const rowValueFont = "11px ui-sans-serif, system-ui, sans-serif";
  const boxPad = { x: 12, y: 10 };
  const rowH = 18;
  const titleH = 22;
  const gap = 6;
  const labelW = 44;

  ctx.font = titleFont;
  const title = `第 ${hand.toLocaleString()} 手`;
  const boxW = Math.max(148, labelW + gap + Math.max(...rows.map((r) => {
    ctx.font = rowValueFont;
    return ctx.measureText(r.value).width;
  })) + boxPad.x * 2);
  const boxH = boxPad.y * 2 + titleH + rows.length * rowH;

  let boxX = x + 12;
  if (boxX + boxW > W - pad.right) boxX = x - boxW - 12;
  boxX = Math.max(pad.left, boxX);
  const boxY = pad.top + 8;

  ctx.fillStyle = "rgba(10, 10, 10, 0.92)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f4f4f5";
  ctx.font = titleFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title, boxX + boxPad.x, boxY + boxPad.y + titleH / 2 - 2);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.beginPath();
  ctx.moveTo(boxX + boxPad.x, boxY + boxPad.y + titleH - 2);
  ctx.lineTo(boxX + boxW - boxPad.x, boxY + boxPad.y + titleH - 2);
  ctx.stroke();

  rows.forEach((row, i) => {
    const ry = boxY + boxPad.y + titleH + i * rowH + rowH / 2;
    ctx.font = rowLabelFont;
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(row.label, boxX + boxPad.x, ry);
    ctx.font = rowValueFont;
    ctx.fillStyle = row.color;
    ctx.fillText(row.value, boxX + boxPad.x + labelW, ry);
  });
}

type StatItem = {
  label: string;
  title: string;
  value: string;
  color?: string;
  emphasis?: "primary" | "rake" | "metric";
  gto?: string; // 标签带里的 GTO 基准小字（如 "21.8"）
};

function profitColor(v: number) {
  return v >= 0 ? "#22c55e" : "#ef4444";
}

function preRakeColor(v: number) {
  return v >= 0 ? COLOR_PRE_RAKE : "#ef4444";
}

function bbPer100(bb: number, hands: number) {
  return hands > 0 ? Math.round((bb / hands) * 10000) / 100 : 0;
}

function buildStatRows(stats: SessionStats, pvi: number | null, evPending = false): StatItem[][] {
  const totalRake = stats.totalHeroRake + stats.totalHeroJackpot;
  const totalRakeBB = stats.totalHeroRakeBB + stats.totalHeroJackpotBB;
  const p100 = (bb: number) => bbPer100(bb, stats.totalHands).toLocaleString();
  // 曲线终点（蓝=摊牌 红=非摊牌 黄=EV 绿=水前）；被欠几组 = (EV−水前)终点÷100
  const last = (arr: { profit: number }[]) => (arr.length ? arr[arr.length - 1].profit : 0);
  const sdEnd = last(stats.sdHistory);
  const nsdEnd = last(stats.nsdHistory);
  const owedBuyins = (last(stats.evHistory) - last(stats.profitHistory)) / 100;

  return [
    [
      { label: "总手数", title: "总手数", value: stats.totalHands.toLocaleString() },
      { label: "常驻级别", title: "常驻级别", value: stats.avgStakes },
      // PVI：pvi 存的是「TP变化/游戏抽水」的商（即百分数值），这里只格式化+拼 %，别再 ×100。
      // 计算与公式说明见下方 setPVI 处的警示注释。
      { label: "PVI", title: "PVI = TP变化 / 游戏抽水（百分比）", value: (pvi !== null ? pvi : 0).toFixed(2) + "%", color: "#a78bfa", emphasis: "primary" },
      { label: "水后 · $", title: "水后总盈利($)", value: "$" + stats.totalProfitCurrency.toFixed(1), color: profitColor(stats.totalProfitCurrency), emphasis: "primary" },
      { label: "水前 · $", title: "水前总盈利($)", value: "$" + stats.gameProfitCurrency.toFixed(1), color: preRakeColor(stats.gameProfitCurrency), emphasis: "primary" },
      { label: "总抽水", title: "总抽水", value: "$" + totalRake.toFixed(1), emphasis: "rake" },
      { label: "游戏抽水", title: "游戏抽水", value: "$" + stats.totalHeroRake.toFixed(1), emphasis: "rake" },
      { label: "JP抽水", title: "JP抽水", value: "$" + stats.totalHeroJackpot.toFixed(1), emphasis: "rake" },
    ],
    [
      // 三个曲线终点新卡置顶；配色：蓝线=蓝 红线=红；被欠 数值不带正负号，负=绿(标签切「跑赢几组」)，EV 未算完=「运气如何」
      { label: "蓝线百手", title: "摊牌线终点的BB/100（曲线蓝线）", value: p100(sdEnd), color: "#3b82f6" },
      { label: "红线百手", title: "非摊牌线终点的BB/100（曲线红线）", value: p100(nsdEnd), color: "#ef4444" },
      { label: evPending ? "运气如何" : owedBuyins < 0 ? "跑赢几组" : "被欠几组", title: "被欠 = (EV线−水前线)终点 ÷ 100（组）；负=跑赢EV，负值自动切成「跑赢几组」", value: evPending ? "计算中…" : Math.abs(owedBuyins).toFixed(2), color: owedBuyins < 0 ? "#22c55e" : "#ef4444" },
      { label: "水后百手", title: "水后总盈利的BB/100", value: p100(stats.netProfitBB), color: profitColor(stats.netProfitBB) },
      { label: "水前百手", title: "水前总盈利的BB/100", value: p100(stats.totalProfitBB), color: preRakeColor(stats.totalProfitBB) },
      { label: "总抽水百手", title: "总抽水的BB/100", value: p100(totalRakeBB), emphasis: "rake" },
      { label: "抽水百手", title: "游戏抽水的BB/100", value: p100(stats.totalHeroRakeBB), emphasis: "rake" },
      { label: "JP抽水百手", title: "JP抽水的BB/100", value: p100(stats.totalHeroJackpotBB), emphasis: "rake" },
    ],
    [
      // GTO 基准（用户 2026-09-22 拍板，展示在数值下方，与位置卡同排式）：
      // VPIP 21.8 / PFR 19.4 / 3BET 10.1 / ATS 37.6；WTSD 系无基准但传空串保持行结构对齐
      { label: "VPIP", title: "VPIP（GTO 基准 21.8%）", value: stats.vpip + "%", emphasis: "metric", gto: "21.8" },
      { label: "PFR", title: "PFR（GTO 基准 19.4%）", value: stats.pfr + "%", emphasis: "metric", gto: "19.4" },
      { label: "3BET", title: "3BET（GTO 基准 10.1%）", value: stats.threeBet + "%", emphasis: "metric", gto: "10.1" },
      { label: "ATS", title: "ATS 综合偷盲率（CO/BTN/SB 的 steal 尝试率；GTO 基准 37.6%）", value: stats.stealTotal + "%", emphasis: "metric", gto: "37.6" },
      { label: "WTSD", title: "WTSD", value: stats.wtsd + "%", emphasis: "metric", gto: "" },
      { label: "WWSF", title: "WWSF", value: stats.wwsf + "%", emphasis: "metric", gto: "" },
      { label: "W$SD", title: "W$SD", value: stats.wsd + "%", emphasis: "metric", gto: "" },
      { label: "", title: "", value: "", gto: "" },
    ],
  ];
}

function UploadIcon() {
  return (
    <svg className="ban2note-upload-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4m0 0L8 8m4-4 4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function StatCard({ label, title, value, color, emphasis, gto }: StatItem) {
  const valueClass = ["ban2-stat-value", emphasis && `ban2-stat-value--${emphasis}`].filter(Boolean).join(" ");
  // 空占位卡：blank 标记让 value 区撑一行高度，整卡与有值卡同尺寸
  const blank = !value;
  // GTO 基准行直接复用位置卡的 ban2-pos-baseline 类——样式与第四行完全一致；
  // 空串 = 无基准但保留行结构对齐
  return (
    <div className={`ban2-stat-card card${blank ? " ban2-stat-card--blank" : ""}`} title={title}>
      <div className="ban2-stat-label">{label}</div>
      <div className={valueClass} style={color ? { color } : undefined}>{value}</div>
      {gto !== undefined && (
        <div className="ban2-pos-baseline">
          {gto ? (
            <>
              <span className="ban2-pos-baseline-label">GTO</span>{" "}
              <span className="ban2-pos-baseline-val ban2-pos-baseline-val--gto">{gto}%</span>
            </>
          ) : (
            "\u00A0"
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------
   位置水后百手行：每个位置的「点击侧栏位置筛选后显示的水后百手」，
   并对照 GTO 基准与 PRO 基准两行参考（bb/100，用户 2026-09-22 拍板数值）。
   口径与 computeStats 的 netProfitBB 完全一致 ——
   netUSD = gameUSDRaw − heroRake − heroJackpot − heroAiiPremium + heroAiiCompensation，
   再除以该手大盲，按 heroPosition 分组累加；只在展示时取整。
   ---------------------------------------------------------------- */
const POS_MAIN_ORDER = ["BB", "SB", "BTN", "CO", "MP", "UTG"];
// GTO / PRO 基准表（6-max，早→晚：UTG MP CO BTN SB BB）
const POS_GTO: Record<string, number> = {
  UTG: 8.6, MP: 10.3, CO: 12.7, BTN: 17.1, SB: -33, BB: -57,
};
const POS_PRO: Record<string, number> = {
  UTG: 10, MP: 12, CO: 18, BTN: 23, SB: -28, BB: -48,
};

function computePositionNetBB(hands: ParsedHand[]): Map<string, { netBB: number; n: number }> {
  const acc = new Map<string, { netBB: number; n: number }>();
  for (const h of hands) {
    if (!h.heroPosition) continue;
    const stake = parseFloat(h.stakes.split("/")[1]);
    const netUSD = h.gameUSDRaw - h.heroRake - h.heroJackpot - h.heroAiiPremium + h.heroAiiCompensation;
    const cur = acc.get(h.heroPosition) ?? { netBB: 0, n: 0 };
    cur.netBB += netUSD / stake;
    cur.n += 1;
    acc.set(h.heroPosition, cur);
  }
  return acc;
}

const signed = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);
const plainNum = (v: number) => String(v);

function PositionCardsRow({ hands }: { hands: ParsedHand[] }) {
  const acc = useMemo(() => computePositionNetBB(hands), [hands]);
  const order = POS_MAIN_ORDER;
  const blankCount = 8 - order.length;

  return (
    <div className="ban2-stat-row ban2-stat-row--dense">
      {order.map((pos) => {
        const e = acc.get(pos);
        const n = e?.n ?? 0;
        const val = n > 0 ? Math.round((e!.netBB / n) * 10000) / 100 : null;
        const gto = POS_GTO[pos];
        const pro = POS_PRO[pos];
        return (
          <div
            key={pos}
            className="ban2-pos-card card"
            title={`${pos} 水后百手（BB/100），与点击位置筛选后的「水后百手」同口径 · GTO 基准 ${gto} · PRO 基准 ${pro} · n=${n.toLocaleString()}`}
          >
            <div className="ban2-pos-head">
              <span className="ban2-pos-name">{pos}</span>
            </div>
            <div className="ban2-stat-value ban2-pos-value" style={{ color: val === null ? "#52525b" : profitColor(val) }}>
              {val === null ? "—" : signed(val)}
            </div>
            <div className="ban2-pos-baseline">
              <span className="ban2-pos-baseline-label">GTO</span>{" "}
              <span className="ban2-pos-baseline-val ban2-pos-baseline-val--gto">{plainNum(gto)}</span>
            </div>
            <div className="ban2-pos-baseline">
              <span className="ban2-pos-baseline-label">PRO</span>{" "}
              <span className="ban2-pos-baseline-val ban2-pos-baseline-val--pro">{plainNum(pro)}</span>
            </div>
          </div>
        );
      })}
      {Array.from({ length: blankCount }, (_, i) => (
        <StatCard key={`pos-blank-${i}`} label="" title="" value="" />
      ))}
    </div>
  );
}

function VariancePanel({
  stats,
  netData,
  loading,
}: {
  stats: SessionStats | null;
  netData: { hand: number; profit: number }[];
  loading: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const analysis = useMemo(() => {
    if (!stats || netData.length < 2) return null;
    const params = deriveFromSession(stats.totalHands, stats.netProfitBB, netData);
    // 蒙特卡洛成本 = 次数 × 手数；超大会话（几十万手）按 5e7 步预算降低模拟次数，
    // 否则运气 tab 会冻结数分钟。小样本仍用满 4000 次。
    const simRuns = Math.max(100, Math.min(4000, Math.floor(5e7 / Math.max(1, params.hands))));
    const { results, stats: sim } = simulate(params.winRate, params.stdDev, params.hands, simRuns);
    const downPct = drawdownPercentile(params.maxDrawdown, sim.downswings);
    const p95Down = sim.downswings[Math.floor(sim.downswings.length * 0.95)] ?? sim.meanDown;
    const sorted = sortResultsByProfit(results);
    const winRateCI = winRateConfidenceInterval(params.winRate, params.stdDev, params.hands);
    return { params, sim, downPct, p95Down, sorted, winRateCI };
  }, [stats, netData]);

  useEffect(() => {
    if (!analysis?.sorted.length || !canvasRef.current) return;

    const canvas = canvasRef.current;
    let rafId = 0;

    const draw = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(() => {
          drawVarianceHistogram(canvas, analysis.sorted, { compact: true });
        });
      });
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    window.addEventListener("resize", draw);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", draw);
      cancelAnimationFrame(rafId);
    };
  }, [analysis]);

  const verdict = analysis && stats ? (() => {
    if (stats.totalHands < 5000) return "手数还不多，下面结果只能看个大概。";
    if (analysis.downPct >= 0.9) return "你的下行比大多数人都深，更像是短期手气不好。";
    if (analysis.downPct <= 0.5) return "你的下行比较浅，波动算比较温和。";
    return "你的下行在常见范围内，不算特别倒霉也不算特别顺。";
  })() : null;

  return (
    <div className={`card ban2note-variance${analysis ? " ban2note-variance--ready" : ""}`}>
      <p className="ban2note-variance-label">波动预估</p>
      {!stats || !analysis ? (
        <>
          <p className="ban2note-variance-title">
            {loading ? "正在读取牌谱…" : "上传后自动估算"}
          </p>
          <p className="ban2note-variance-desc">
            会用你的真实打法，模拟「同样手数下大概赢多少、最多能亏多深」。
          </p>
        </>
      ) : (
        <>
          <p className="ban2note-variance-summary">
            {analysis.params.hands.toLocaleString()} 手 · 每百手 {analysis.params.winRate >= 0 ? "+" : ""}{analysis.params.winRate} bb · 波动 {analysis.params.stdDev}
          </p>

          <div className="ban2note-variance-chart-wrap">
            <canvas ref={canvasRef} className="ban2note-variance-chart" />
          </div>
          <p className="ban2note-variance-chart-caption">
            红=输钱概率 · 金=赢钱概率 · 虚线=盈亏平衡
          </p>

          <div className="ban2note-variance-metrics">
            <div className="ban2note-variance-metric">
              <span className="ban2note-variance-metric-label">你的最大回撤</span>
              <span className="ban2note-variance-metric-value">{analysis.params.maxDrawdown} bb</span>
            </div>
            <div className="ban2note-variance-metric">
              <span className="ban2note-variance-metric-label">模拟平均回撤</span>
              <span className="ban2note-variance-metric-value">{Math.round(analysis.sim.meanDown)} bb</span>
            </div>
            <div className="ban2note-variance-metric">
              <span className="ban2note-variance-metric-label">可能最大回撤</span>
              <span className="ban2note-variance-metric-value">{Math.round(analysis.p95Down)} bb</span>
            </div>
          </div>

          {verdict && <p className="ban2note-variance-verdict">{verdict}</p>}

          {analysis.winRateCI && (
            <p className="ban2note-variance-desc">
              根据这 {analysis.params.hands.toLocaleString()} 手牌预估，你的真实水平大约是 {Math.round(analysis.winRateCI.low)} ~ {Math.round(analysis.winRateCI.high)} bb/100（水后，95% 把握）。
            </p>
          )}
        </>
      )}
    </div>
  );
}

function LuckPanel({ luckStats }: { luckStats: LuckStats | null }) {
  if (!luckStats) return null;

  return (
    <>
      {/* 起手牌频率 + 实际赢率：六张卡片 */}
      <div className="card ban2note-luck-block">
        <p className="ban2note-luck-label">起手牌 · 到手次数与赢率</p>
        <div className="ban2note-luck-cards">
          {luckStats.premiumFreq.map((p) => (
            <div key={p.label} className="ban2note-luck-card">
              <div className="ban2note-luck-card-hand">{p.label}</div>
              <div className="ban2note-luck-card-count">
                <span className="ban2note-luck-card-actual">{p.count}</span>
                <span className="ban2note-luck-card-sep">/</span>
                <span className="ban2note-luck-card-theory">{p.theoryCount}</span>
              </div>
              <div className="ban2note-luck-card-meta">
                <span className="ban2note-luck-card-rate" style={{ color: p.wsdPct >= 50 ? "#22c55e" : "#ef4444" }}>
                  {p.count > 0 ? `${p.wsdPct}%` : "—"}
                </span>
                <span className="ban2note-luck-card-rate-label">W$SD</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 各街击中两对+的次数 + 其中输掉的次数 */}
      <div className="card ban2note-luck-block">
        <p className="ban2note-luck-label">成牌运气 · 击中两对+的摊牌结果</p>
        <div className="ban2note-luck-streets">
          {luckStats.streetTwoPair.map((s) => (
            <div key={s.street} className="ban2note-luck-street-card">
              <div className="ban2note-luck-street-name">
                {s.street === "flop" ? "翻牌圈" : s.street === "turn" ? "转牌圈" : "河牌圈"}
              </div>
              <div className="ban2note-luck-street-wsd">
                {s.reachedCount > 0 ? s.deadCount : "—"}
                <span className="ban2note-luck-street-total">/{s.reachedCount}</span>
              </div>
              <div className="ban2note-luck-street-detail">
                输/总
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// 详细数据：HM3/PT4 风格 stats 矩阵，按分组横向排列
// 每个指标：{ key, label, value }，value 为 null 表示尚未实现（显示 —）
type DetailCell = { key: string; label: string; value: string | null };
type DetailGroup = { name: string; cells: DetailCell[] };

function buildDetailGroups(stats: SessionStats): DetailGroup[] {
  const totalRake = stats.totalHeroRake + stats.totalHeroJackpot;
  const DASH = null;
  const fmt = (v: number, suffix = "") => v === 0 && suffix === "%" ? DASH : `${v}${suffix}`;
  const money = (v: number) => `$${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(0)}`;

  // Street metrics — standard HM3/PT4 labels
  const streetCells = (s: { cbet: number; cbetIP: number; cbetOOP: number; fvc: number; fvcIP: number; fvcOOP: number; donk: number; checkC: number; checkR: number; afq: number }): DetailCell[] => [
    { key: "", label: "CBet", value: fmt(s.cbet, "%") },
    { key: "", label: "CBet IP", value: fmt(s.cbetIP, "%") },
    { key: "", label: "CBet OOP", value: fmt(s.cbetOOP, "%") },
    { key: "", label: "FvCB", value: fmt(s.fvc, "%") },
    { key: "", label: "FvCB IP", value: fmt(s.fvcIP, "%") },
    { key: "", label: "FvCB OOP", value: fmt(s.fvcOOP, "%") },
    { key: "", label: "Donk", value: fmt(s.donk, "%") },
    { key: "", label: "CheckC", value: fmt(s.checkC, "%") },
    { key: "", label: "CheckR", value: fmt(s.checkR, "%") },
  ];

  return [
    {
      name: "Basic stats",
      cells: [
        { key: "hands", label: "Hands", value: stats.totalHands.toLocaleString() },
        { key: "winnings", label: "Winnings", value: money(stats.totalProfitCurrency) },
        { key: "bb100", label: "bb/100", value: stats.totalHands > 0 ? String(Math.round(stats.netProfitBB / stats.totalHands * 10000) / 100) : DASH },
        { key: "vpip", label: "VPIP", value: fmt(stats.vpip, "%") },
        { key: "pfr", label: "PFR", value: fmt(stats.pfr, "%") },
        { key: "steal-total", label: "Steal Total", value: fmt(stats.stealTotal, "%") },
        { key: "steal-btn", label: "Steal BTN", value: fmt(stats.stealBTN, "%") },
        { key: "steal-sb", label: "Steal SB", value: fmt(stats.stealSB, "%") },
      ],
    },
    {
      name: "PreFlop",
      cells: [
        { key: "3bet", label: "3Bet", value: fmt(stats.threeBet, "%") },
        { key: "squeeze", label: "Squeeze", value: fmt(stats.squeeze, "%") },
        { key: "4bet", label: "4Bet", value: fmt(stats.fourBet, "%") },
        { key: "pf-fold-3bet", label: "Fold to 3Bet", value: fmt(stats.foldToThreeBet, "%") },
        { key: "pf-fold-4bet", label: "Fold to 4Bet", value: fmt(stats.foldToFourBet, "%") },
        { key: "wwsf", label: "WWSF", value: fmt(stats.wwsf, "%") },
        { key: "wtsd", label: "WTSD", value: fmt(stats.wtsd, "%") },
        { key: "wsd", label: "W$SD", value: fmt(stats.wsd, "%") },
      ],
    },
    { name: "Flop", cells: streetCells(stats.flop) },
    { name: "Turn", cells: streetCells(stats.turn) },
    { name: "River", cells: streetCells(stats.river) },
  ];
}

function DetailStats({ stats }: { stats: SessionStats }) {
  const groups = buildDetailGroups(stats);
  return (
    <div className="ban2note-detail">
      <div className="ban2note-detail-wip">
        ⚠️ 当前页面开发中，数据可能不准确，请关注后续版本更新。
      </div>
      {groups.map((g) => (
        <div key={g.name} className="card ban2note-detail-group">
          <div className="ban2note-detail-group-name">{g.name}</div>
          <div className="ban2note-detail-cells">
            {g.cells.map((c) => (
              <div key={c.key} className="ban2note-detail-cell">
                <div className="ban2note-detail-value">{c.value ?? "—"}</div>
                <div className="ban2note-detail-label">{c.label}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="ban2note-detail-note">Metrics marked &quot;—&quot; are pending implementation.</p>
    </div>
  );
}

type UploadMeta = {
  sourceFiles: number;
  txtCount: number;
  firstName: string;
  skipped: number;
  duplicateHands: number;
  totalHands: number;   // 上传时的全量手数（不受筛选影响），用于上传卡片展示
};

export default function HandTracker() {
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadMeta, setUploadMeta] = useState<UploadMeta | null>(null);
  const [loadingHint, setLoadingHint] = useState("");
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [data, setData] = useState<{ hand: number; profit: number }[]>([]);
  const [netData, setNetData] = useState<{ hand: number; profit: number }[]>([]);
  const [sdData, setSdData] = useState<{ hand: number; profit: number }[]>([]);
  const [nsdData, setNsdData] = useState<{ hand: number; profit: number }[]>([]);
  const [evData, setEvData] = useState<{ hand: number; profit: number }[]>([]);
  const [parsedHands, setParsedHands] = useState<ParsedHand[]>([]);
  const [startTP, setStartTP] = useState("0");
  const [endTP, setEndTP] = useState("0");
  const [pvi, setPVI] = useState<number | null>(null);
  const [stakeFilters, setStakeFilters] = useState<string[]>([]);
  const [positionFilter, setPositionFilter] = useState<string | null>(null);
  const [seatCountFilters, setSeatCountFilters] = useState<number[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [rightPage, setRightPage] = useState<"data" | "luck" | "detail" | "gto" | "profit" | "handlog">("data");
  const [shareOpen, setShareOpen] = useState(false);
  // 会员云端：登录态 + 面板开关 + 存云状态（auth 挂了不影响本地功能，fetchMe 失败当未登录）
  const [me, setMe] = useState<MeUser | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [cloudSave, setCloudSave] = useState<{ phase: "idle" | "saving" | "ok" | "err"; msg?: string }>({ phase: "idle" });
  // 存云命名弹层：saveAsk=是否显示，saveName=输入中的名字
  const [saveAsk, setSaveAsk] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [curveVis, setCurveVis] = useState<CurveVis>(CURVE_ALL_ON);
  // 两阶段解析：EV 尚在 Worker 后台补算时为 true——EV 线/图例/tooltip 暂不显示
  // （此时 allInEV 未定，evData 是「实际盈亏」fallback，画出来会误导）
  const [evPending, setEvPending] = useState(false);
  const sessionRef = useRef<ParseSession | null>(null);
  // 卸载标记：大包解析动辄几分钟，导航离开后 Worker 空转烧 CPU、EV 批持续
  // setState（React 18 静默但备份请求会照发）——卸载时终止会话并放流程短路
  const unmountedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      sessionRef.current?.terminate();
      sessionRef.current = null;
    };
  }, []);
  // EV 批到达但基础数据尚未渲染时先暂存，applyParsedHands 后统一放行
  const pendingEvRef = useRef<EvBatchMsg[]>([]);
  const evLiveRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const appendFileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const crossIdxRef = useRef(-1);
  const hoverIdxRef = useRef(-1);

  const resetFileInputs = useCallback(() => {
    if (fileRef.current) fileRef.current.value = "";
    if (appendFileRef.current) appendFileRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
  }, []);

  const clearParsedResults = useCallback(() => {
    setStats(null);
    setUploadMeta(null);
    setData([]);
    setNetData([]);
    setSdData([]);
    setNsdData([]);
    setEvData([]);
    setPVI(null);
    setParsedHands([]);
    setStakeFilters([]);
    setPositionFilter(null);
    setSeatCountFilters([]);
    setDateRange(null);
    setEvPending(false);
    evLiveRef.current = false;
    pendingEvRef.current = [];
  }, []);

  const applyParsedHands = useCallback((
    hands: ParsedHand[],
    meta: Pick<UploadMeta, "sourceFiles" | "txtCount" | "firstName" | "skipped"> & { duplicateHands: number },
    totalChars: number,
  ) => {
    if (hands.length === 0) {
      setUploadError("未解析出任何手牌，请确认上传的是 GGPoker / CoinPoker 牌谱（.txt / .zip）");
      clearParsedResults();
      return false;
    }

    const s = computeStats(hands);
    setPVI(null);
    setParsedHands(hands);
    setStakeFilters([]);
    setPositionFilter(null);
    setSeatCountFilters([]);
    setDateRange(null);
    setUploadMeta({
      sourceFiles: meta.sourceFiles,
      txtCount: meta.txtCount,
      firstName: meta.firstName,
      skipped: meta.skipped,
      duplicateHands: meta.duplicateHands,
      totalHands: s.totalHands,
    });
    setStats(s);
    setData(s.profitHistory);
    setNetData(s.netProfitHistory);
    setSdData(s.sdHistory);
    setNsdData(s.nsdHistory);
    setEvData(s.evHistory);

    // 备份：dedupedText 是全部牌谱原文的拼接，超大上传（几十万手）拼接本身就要
    // 数 GB 内存、请求体也超出 Worker 承受能力，故超过阈值时跳过备份
    if (totalChars <= BACKUP_MAX_CHARS) {
      const dedupedText = hands.map((h) => h.raw).join("\n\n");
      fetch("/api/backup", {
        method: "POST",
        body: dedupedText,
        headers: {
          "X-Ban2-Player": "Hero",
          "X-Ban2-Hands": String(s.totalHands),
          "X-Ban2-Stakes": s.avgStakes,
          "X-Ban2-Net-BB": String(s.netProfitBB),
        },
      })
        .then((r) => r.json())
        .then((r) => {
          if (r.deduped) console.info("[ban2note] backup skipped (duplicate):", r.key);
        })
        .catch((err) => {
          console.warn("[ban2note] backup failed:", err);
        });
    } else {
      console.info(`[ban2note] 牌谱量过大（约 ${(totalChars / 1048576).toFixed(0)} MB 文本），已跳过服务器备份`);
    }

    return true;
  }, [clearParsedResults]);

  // 筛选：按选中的级别（多选）、位置（单选）、桌上人数（多选）过滤手牌后重算 stats / 曲线
  useEffect(() => {
    if (parsedHands.length === 0) return;
    const selected = new Set(stakeFilters);
    const seats = new Set(seatCountFilters);
    const dateStart = dateRange ? dateRangeStart(dateRange) : null;
    const filtered = parsedHands.filter((h) => {
      const nl = stakesToNL(h.stakes);
      const stakeOk = selected.size === 0 || (nl !== null && selected.has(nl));
      const posOk = !positionFilter || h.heroPosition === positionFilter;
      const seatOk = seats.size === 0 || seats.has(h.numSeats);
      const dateOk = dateStart === null || handDateToTs(h.date) >= dateStart;
      return stakeOk && posOk && seatOk && dateOk;
    });
    const s = computeStats(filtered);
    setStats(s);
    setData(s.profitHistory);
    setNetData(s.netProfitHistory);
    setSdData(s.sdHistory);
    setNsdData(s.nsdHistory);
    setEvData(s.evHistory);
  }, [parsedHands, stakeFilters, positionFilter, seatCountFilters, dateRange]);

  // 十字线只在「筛选条件或数据集本身」变化时清零。EV 后台补算每批都会重建
  // parsedHands 数组（身份变、集合不变），此前按身份清零会把用户点选的锁定
  // 十字线每 1~2 秒打断一次（2026-11-03 审查 P3）。首尾 id + 数量做数据指纹：
  // EV 批指纹不变（不清），换数据/新解析指纹变（清）。
  const crosshairResetKey = `${stakeFilters.join(",")}|${positionFilter ?? ""}|${seatCountFilters.join(",")}|${dateRange ?? ""}|${parsedHands.length}|${parsedHands[0]?.id ?? ""}|${parsedHands[parsedHands.length - 1]?.id ?? ""}`;
  useEffect(() => {
    crossIdxRef.current = -1;
    hoverIdxRef.current = -1;
  }, [crosshairResetKey]);

  // 级别筛选 chip：有数据时只显示手牌中实际存在的级别，无数据时显示完整预设
  const availableStakes = useMemo(() => {
    const set = new Set<string>();
    for (const h of parsedHands) {
      const nl = stakesToNL(h.stakes);
      if (nl) set.add(nl);
    }
    if (set.size === 0) return STAKE_FILTERS;
    return [...set].sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
  }, [parsedHands]);

  // 位置筛选 chip：手牌中实际存在的位置，从晚到早排序（与位置卡同向）；无数据时显示完整预设
  const availablePositions = useMemo(() => {
    const set = new Set<string>();
    for (const h of parsedHands) {
      if (h.heroPosition) set.add(h.heroPosition);
    }
    if (set.size === 0) return POSITION_FILTERS;
    // 与位置卡同向：从晚到早 BB→SB→BTN→CO→…→UTG
    const ORDER = ["BB", "SB", "BTN", "CO", "HJ", "MP", "UTG+2", "UTG+1", "UTG"];
    return [...set].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  }, [parsedHands]);

  // 桌上人数筛选 chip：手牌中实际存在的入座人数；无数据时显示完整预设 2-8
  const availableSeatCounts = useMemo(() => {
    const set = new Set<number>();
    for (const h of parsedHands) {
      if (h.numSeats >= 2) set.add(h.numSeats);
    }
    if (set.size === 0) return [2, 3, 4, 5, 6, 7, 8];
    return [...set].sort((a, b) => a - b);
  }, [parsedHands]);

  // 运气统计：基于当前筛选后的手牌计算（与 stats 同步）
  const luckStats = useMemo<LuckStats | null>(() => {
    if (parsedHands.length === 0) return null;
    const selected = new Set(stakeFilters);
    const seats = new Set(seatCountFilters);
    const dateStart = dateRange ? dateRangeStart(dateRange) : null;
    const filtered = parsedHands.filter((h) => {
      const nl = stakesToNL(h.stakes);
      const stakeOk = selected.size === 0 || (nl !== null && selected.has(nl));
      const posOk = !positionFilter || h.heroPosition === positionFilter;
      const seatOk = seats.size === 0 || seats.has(h.numSeats);
      const dateOk = dateStart === null || handDateToTs(h.date) >= dateStart;
      return stakeOk && posOk && seatOk && dateOk;
    });
    return computeLuckStats(filtered);
  }, [parsedHands, stakeFilters, positionFilter, seatCountFilters, dateRange]);

  // 当前筛选后的手牌（供「对比GTO」tab 复用，逻辑与 stats/luck 一致）
  const filteredHands = useMemo(() => {
    const selected = new Set(stakeFilters);
    const seats = new Set(seatCountFilters);
    const dateStart = dateRange ? dateRangeStart(dateRange) : null;
    return parsedHands.filter((h) => {
      const nl = stakesToNL(h.stakes);
      const stakeOk = selected.size === 0 || (nl !== null && selected.has(nl));
      const posOk = !positionFilter || h.heroPosition === positionFilter;
      const seatOk = seats.size === 0 || seats.has(h.numSeats);
      const dateOk = dateStart === null || handDateToTs(h.date) >= dateStart;
      return stakeOk && posOk && seatOk && dateOk;
    });
  }, [parsedHands, stakeFilters, positionFilter, seatCountFilters, dateRange]);

  // 一键分享的第四行数据：与 PositionCardsRow 同口径，压平成纯数据给 ShareModal 绘制
  const sharePosCards = useMemo<SharePosCard[]>(() => {
    if (!stats) return [];
    const acc = computePositionNetBB(filteredHands);
    return POS_MAIN_ORDER.map((pos) => {
      const e = acc.get(pos);
      const n = e?.n ?? 0;
      const val = n > 0 ? Math.round((e!.netBB / n) * 10000) / 100 : null;
      return {
        pos,
        val: val === null ? "—" : signed(val),
        color: val === null ? "#52525b" : profitColor(val),
        gto: POS_GTO[pos],
        pro: POS_PRO[pos],
      };
    });
  }, [stats, filteredHands]);

  const processFiles = useCallback(async (files: FileList | File[], mode: "replace" | "append" = "replace") => {
    // 解析进行中拒绝再入：拖拽/文件选择路径已有 !loading 门禁，但云端「载入选中」
    // 面板此前没有——两条流程并发会交叉 setLoading/clearParsedResults/EV 队列，
    // 渲染出部分合并的中间数据（2026-11-03 审查 P2）
    if (loading) return;
    // 追加模式只在已有结果时生效：以现有手牌打底合并，失败/空批次不清空已有结果
    const prevMeta = mode === "append" && parsedHands.length > 0 ? uploadMeta : null;
    const append = prevMeta !== null;
    setLoading(true);
    setUploadError(null);
    if (!append) clearParsedResults();
    setDragOver(false);
    dragDepthRef.current = 0;
    // 新上传作废仍在跑的旧解析会话（含其 EV 后台补算），防两批消息交叉污染
    sessionRef.current?.terminate();
    sessionRef.current = null;
    evLiveRef.current = false;
    pendingEvRef.current = [];
    setEvPending(false);
    try {
      const fileArray = Array.from(files);
      let sourceFiles = 0;
      let skipped = 0;
      let txtCount = 0;
      let duplicateHands = 0;
      let totalChars = 0;
      let firstName = "";
      let order = 0;

      // 超大上传（几十万手）不能走「全文拼接 + 一次性解析」：拼接出的字符串本身
      // 就是数百 MB，峰值内存把浏览器标签页打爆。改为逐文件解析、按手牌 id 合并
      // 去重，每批之间让出主线程，转圈动画不冻结、提示能实时更新。
      const merged = new Map<string, ParsedHand>();
      const ordById = new Map<string, number>();

      // 追加：现有手牌先进合并表，新牌与旧牌同 id 自然计入重复
      if (append) {
        for (const h of parsedHands) {
          merged.set(h.id, h);
          ordById.set(h.id, order++);
        }
      }

      // EV 增量合并：阶段二每批把 allInEV 写回 parsedHands，筛选/曲线 effect 自动重算。
      // allInEV===null 才写入（重复 id 或已算过的手不覆盖）
      const applyEvBatch = (b: EvBatchMsg) => {
        setParsedHands((prevHands) => {
          if (prevHands.length === 0) return prevHands;
          const idx = new Map(prevHands.map((hh, i) => [hh.id, i] as const));
          const next = prevHands.slice();
          let changed = false;
          for (const { id, allInEV } of b.results) {
            const i = idx.get(id);
            if (i !== undefined && next[i].allInEV === null) {
              next[i] = { ...next[i], allInEV };
              changed = true;
            }
          }
          return changed ? next : prevHands;
        });
      };

      let failed = false;
      let evTotalSeen = 0;
      const session = startParseSession({
        onProgress: (p) => {
          setLoadingHint(
            `正在解析 · 已扫描 ${p.scanned.toLocaleString()} / ${p.total.toLocaleString()} 手 · 已收录 ${p.kept.toLocaleString()} 手`,
          );
        },
        onHands: (r) => {
          duplicateHands += r.duplicateHands;
          if (r.evTotal > evTotalSeen) evTotalSeen = r.evTotal;
          for (const hh of r.hands) {
            if (merged.has(hh.id)) {
              duplicateHands++;
              continue;
            }
            merged.set(hh.id, hh);
            ordById.set(hh.id, order++);
          }
        },
        onEvBatch: (b) => {
          if (evLiveRef.current) applyEvBatch(b);
          else pendingEvRef.current.push(b);
        },
        onEvDone: () => {
          setEvPending(false);
        },
        onError: (message) => {
          failed = true;
          setUploadError(
            message || "解析失败，请检查文件格式。支持 GGPoker / CoinPoker 手牌历史 txt / zip 文件。",
          );
          if (!append) clearParsedResults();
        },
      });
      sessionRef.current = session;

      setLoadingHint(`正在读取 ${fileArray.length} 个文件…`);

      for (const f of fileArray) {
        if (!isHandHistoryFile(f.name)) {
          skipped++;
          continue;
        }
        sourceFiles++;
        if (!firstName) firstName = f.name;
        // 无条件以 Hero 解析：GG 导出固定把玩家自己写成 "Hero"（对手是十六进制 ID）；
        // 个别渠道导出真实昵称时，parseGGHandHistory 内部会自动检测替换。
        await readHandHistoryFile(f, async (text) => {
          txtCount++;
          totalChars += text.length;
          session.postText(text);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }, setLoadingHint);
      }
      session.finish();
      // 阶段一完成：全部手牌已合并。此时先渲染基础数据与非 EV 曲线，
      // EV 转入 Worker 后台逐批补算（见 onEvBatch）。
      await session.allTextsParsed;
      // 页面已卸载：setState 全部无效，别再走 applyParsedHands（会照发备份请求）
      if (unmountedRef.current) return;
      if (failed) {
        setLoading(false);
        setLoadingHint("");
        resetFileInputs();
        return;
      }

      if (merged.size === 0) {
        setUploadError(
          skipped > 0
            ? `未找到有效的 .txt / .zip 文件（已跳过 ${skipped} 个不支持的文件）`
            : "没有有效的文件，请上传 GGPoker / CoinPoker 手牌历史",
        );
        clearParsedResults();
        setLoading(false);
        setLoadingHint("");
        resetFileInputs();
        return;
      }

      if (append && merged.size === parsedHands.length) {
        setUploadError(
          `没有新增手牌${skipped > 0 ? `（已跳过 ${skipped} 个不支持的文件）` : ""}，本次所选文件的手牌均已导入`,
        );
        setLoading(false);
        setLoadingHint("");
        resetFileInputs();
        return;
      }

      // 按日期排序（同日期按读取顺序稳定排列），随后释放合并用的中间结构
      const hands = [...merged.values()].sort((a, b) => {
        const byDate = handDateToTs(a.date) - handDateToTs(b.date);
        if (Number.isFinite(byDate) && byDate !== 0) return byDate;
        return (ordById.get(a.id) ?? 0) - (ordById.get(b.id) ?? 0);
      });
      merged.clear();
      ordById.clear();

      const finalMeta = append
        ? {
            sourceFiles: prevMeta.sourceFiles + sourceFiles,
            txtCount: prevMeta.txtCount + txtCount,
            firstName: prevMeta.firstName,
            skipped: prevMeta.skipped + skipped,
            duplicateHands: prevMeta.duplicateHands + duplicateHands,
          }
        : { sourceFiles, txtCount, firstName, skipped, duplicateHands };
      // 追加后备份口径是「合并全量」的拼接文本，字符数直接按最终手牌原文汇总
      const finalChars = append
        ? hands.reduce((n, h) => n + h.raw.length, 0)
        : totalChars;

      if (!applyParsedHands(hands, finalMeta, finalChars)) {
        setLoading(false);
        setLoadingHint("");
        resetFileInputs();
        return;
      }
      // 基础数据已渲染：放行 EV 批（先到的一并补上），曲线进入渐进点亮
      evLiveRef.current = true;
      if (evTotalSeen > 0) setEvPending(true);
      const pendingBatches = pendingEvRef.current;
      pendingEvRef.current = [];
      for (const b of pendingBatches) applyEvBatch(b);
    } catch {
      setUploadError("解析失败，请检查文件格式。支持 GGPoker / CoinPoker 手牌历史 txt / zip 文件。");
      if (!append) clearParsedResults();
    }
    setLoading(false);
    setLoadingHint("");
    resetFileInputs();
  }, [loading, resetFileInputs, applyParsedHands, clearParsedResults, parsedHands, uploadMeta]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;
    dragDepthRef.current += 1;
    setDragOver(true);
  }, [loading]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragOver(false);
    if (!loading && e.dataTransfer.files.length) {
      processFiles(e.dataTransfer.files);
    }
  }, [loading, processFiles]);

  const openFilePicker = useCallback(() => {
    if (!loading) fileRef.current?.click();
  }, [loading]);

  const openAppendPicker = useCallback(() => {
    if (!loading) appendFileRef.current?.click();
  }, [loading]);

  const openFolderPicker = useCallback(() => {
    if (!loading) folderRef.current?.click();
  }, [loading]);

  useEffect(() => {
    if (data.length < 2 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    let rafId = 0;

    const draw = () => {
      cancelAnimationFrame(rafId);
      // Double rAF: wait for layout to settle after window maximize/resize
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(() => {
          if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
            drawChart(
              canvas,
              data,
              netData,
              sdData,
              nsdData,
              evData,
              crossIdxRef.current,
              hoverIdxRef.current,
              // EV 尚在后台补算时整线隐藏（此时 evData 是实际盈亏 fallback，画了误导）
              evPending ? { ...curveVis, ev: false } : curveVis,
            );
          }
        });
      });
    };

    const idxAt = (clientX: number) => {
      const r = canvas.getBoundingClientRect();
      const plotW = r.width - CHART_PAD.left - CHART_PAD.right;
      const mx = clientX - r.left;
      if (mx < CHART_PAD.left || mx > CHART_PAD.left + plotW) return -1;
      return Math.max(0, Math.min(data.length - 1, Math.round(((mx - CHART_PAD.left) / plotW) * (data.length - 1))));
    };

    const onMove = (e: MouseEvent) => {
      const idx = idxAt(e.clientX);
      if (idx !== hoverIdxRef.current) {
        hoverIdxRef.current = idx;
        draw();
      }
    };
    const onLeave = () => {
      if (hoverIdxRef.current !== -1) {
        hoverIdxRef.current = -1;
        draw();
      }
    };
    const onClick = (e: MouseEvent) => {
      const idx = idxAt(e.clientX);
      if (idx < 0) return;
      crossIdxRef.current = crossIdxRef.current === idx ? -1 : idx;
      draw();
    };

    draw();
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    window.addEventListener("resize", draw);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      ro.disconnect();
      window.removeEventListener("resize", draw);
      cancelAnimationFrame(rafId);
    };
  }, [data, netData, sdData, nsdData, evData, rightPage, curveVis, evPending]);

  // 解析完成 actions：存到云端分两步——先弹命名框（预填默认名，必须过一次命名），确认后才真正上传
  const askSaveToCloud = useCallback(() => {
    if (!me) { setCloudOpen(true); return; }
    if (!parsedHands.length) return;
    const d = new Date();
    const p = (x: number) => String(x).padStart(2, "0");
    setSaveName(`ban2note-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${parsedHands.length}手.txt`);
    setSaveAsk(true);
  }, [me, parsedHands]);

  const doSaveCloud = useCallback(async () => {
    const name = saveName.trim();
    if (!name || !parsedHands.length) return;
    setSaveAsk(false);
    setCloudSave({ phase: "saving" });
    try {
      const text = parsedHands.map((h) => h.raw).join("\n\n");
      const r = await uploadHands(text, name, parsedHands.length);
      if (r.deduped) {
        setCloudSave({ phase: "ok", msg: `内容与云端「${r.existingName ?? "已有文件"}」完全相同，未重复存储` });
      } else {
        setCloudSave({ phase: "ok", msg: `已存 ${(r.bytes / 1024).toFixed(1)} KB，可在「我的手牌库」查看` });
      }
    } catch (e) {
      setCloudSave({ phase: "err", msg: e instanceof Error ? e.message : "存储失败" });
    }
  }, [saveName, parsedHands]);

  // 云端文件载入：勾选的文件下载后包装成 File[] 走本地解析主流程（解析永远在本地）
  const loadCloudFiles = useCallback((list: File[]) => {
    void processFiles(list);
  }, [processFiles]);

  // 进页面查一次登录态；失败静默（等同未登录，本地功能照常）
  useEffect(() => { void fetchMe().then(setMe); }, []);

  // 登录态变化广播给全站顶栏（Navbar 的会员按钮要跟着换用户名）
  // 后台门禁流程：?cloud=1&back=/xxx 进来登录后要送回的目标页
  const backTarget = useRef<string | null>(null);

  const handleMeChange = useCallback((u: MeUser | null) => {
    setMe(u);
    window.dispatchEvent(new CustomEvent("bs-me", { detail: u }));
    // 带 back 参数进来（后台门禁流程）：登录成功直接送回目标页
    if (u && backTarget.current) {
      const target = backTarget.current;
      backTarget.current = null;
      window.location.assign(target); // 整页跳转，目标页自己重拉登录态
    }
  }, []);

  // 顶栏会员按钮入口：其他页跳 ?cloud=1 过来自动开弹窗；本页点击广播 bs-open-cloud 事件
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("cloud") === "1") {
      const back = new URLSearchParams(window.location.search).get("back");
      if (back && back.startsWith("/") && !back.startsWith("//")) backTarget.current = back;
      setCloudOpen(true);
      // 有 back 时保留参数（登录成功后整页跳走）；否则照旧清掉参数，刷新不重弹
      if (!backTarget.current) window.history.replaceState(null, "", window.location.pathname);
    }
    const open = () => setCloudOpen(true);
    window.addEventListener("bs-open-cloud", open);
    return () => window.removeEventListener("bs-open-cloud", open);
  }, []);

  const uploadClass = [
    "card",
    "ban2note-upload",
    dragOver && "ban2note-upload--drag",
    loading && "ban2note-upload--loading",
    stats && uploadMeta && "ban2note-upload--done",
  ].filter(Boolean).join(" ");

  return (
    <div className="ban2note-page">
      <Navbar />

      <div className="ban2note-layout">
        {/* 最左：荣耀致谢滚动栏（仅 ≥1900px 宽屏显示，窄屏 display:none） */}
        <CreditsRail />

        {/* 左侧：操作面板 */}
        <aside className="ban2note-sidebar">
          <div className="ban2note-header">
            <h1 className="ban2note-title">Ban2Note 数据分析</h1>
            <p className="ban2note-desc">
              现已支持GG Zoom/NL 与 CoinPoker NL手牌
            </p>
            <p className="ban2note-desc ban2note-desc--warn">
              牌谱会备份到服务器用于问题排查和新功能开发，介意勿用。
            </p>
            <div className="b2c-entry">
              <button type="button" className="b2c-ghost" onClick={() => setCloudOpen(true)}>
                {me ? `☁ 我的手牌库 · ${me.username}` : "☁ 登录 / 注册 · 手牌云存储"}
              </button>
            </div>
          </div>

          {/* 拖拽上传 */}
          <div className="ban2note-field">
            <div
              className={uploadClass}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              role="region"
              aria-label="手牌历史上传区域"
              aria-busy={loading || undefined}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.zip"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) processFiles(e.target.files);
                }}
              />
              <input
                ref={appendFileRef}
                type="file"
                accept=".txt,.zip"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) processFiles(e.target.files, "append");
                }}
              />
              <input
                ref={folderRef}
                type="file"
                // @ts-expect-error webkitdirectory is non-standard
                webkitdirectory=""
                directory=""
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) processFiles(e.target.files);
                }}
              />

              {uploadError && (
                <div className="ban2note-upload-error" role="alert">
                  {uploadError}
                </div>
              )}

              {loading ? (
                <div className="ban2note-upload-body">
                  <div className="ban2note-upload-spinner" aria-hidden="true" />
                  <div className="ban2note-upload-title">正在解析牌谱…</div>
                  <div className="ban2note-upload-sub">{loadingHint || "大文件可能需要数秒，请稍候"}</div>
                </div>
              ) : stats && uploadMeta ? (
                <div className="ban2note-upload-body" role="status">
                  <div className="ban2note-upload-success-icon" aria-hidden="true">✓</div>
                  <div className="ban2note-upload-title">解析完成</div>
                  <div className="ban2note-upload-sub">
                    已导入 {uploadMeta.txtCount} 个牌谱 · 共 {uploadMeta.totalHands.toLocaleString()} 手
                    {uploadMeta.sourceFiles > 1 ? ` · 来自 ${uploadMeta.sourceFiles} 个文件` : ""}
                    {uploadMeta.duplicateHands > 0 ? ` · 已去重 ${uploadMeta.duplicateHands.toLocaleString()} 手` : ""}
                  </div>
                  <div className="ban2note-upload-sub ban2note-upload-filename">{uploadMeta.firstName}</div>
                  <div className="ban2note-upload-actions">
                    <button type="button" className="ban2note-upload-btn" onClick={openFilePicker}>更换文件</button>
                    <button type="button" className="ban2note-upload-btn ban2note-upload-btn--outline" onClick={openAppendPicker}>增加文件</button>
                    <button type="button" className="ban2note-upload-btn ban2note-upload-btn--outline" onClick={openFolderPicker}>导入文件夹</button>
                    <button type="button" className="ban2note-upload-btn ban2note-upload-btn--outline" onClick={askSaveToCloud} disabled={cloudSave.phase === "saving"}>
                      {cloudSave.phase === "saving" ? "存云中…" : "☁ 存到云端"}
                    </button>
                  </div>
                  {cloudSave.phase !== "idle" && (
                    <div className={`b2c-save-state${cloudSave.phase === "ok" ? " b2c-save-state--ok" : ""}${cloudSave.phase === "err" ? " b2c-save-state--err" : ""}`} role="status">
                      {cloudSave.phase === "saving" && "正在压缩上传，大文件可能需要十几秒…"}
                      {cloudSave.phase === "ok" && `✓ ${cloudSave.msg}`}
                      {cloudSave.phase === "err" && `✗ ${cloudSave.msg}`}
                    </div>
                  )}
                </div>
              ) : (
                <div className="ban2note-upload-body">
                  <UploadIcon />
                  <div className="ban2note-upload-title">
                    {dragOver ? "松开以上传" : "拖拽文件到此处"}
                  </div>
                  <div className="ban2note-upload-sub">支持 .txt、.zip（含嵌套 zip）及文件夹批量导入</div>
                  <div className="ban2note-upload-actions">
                    <button type="button" className="ban2note-upload-btn" onClick={openFilePicker}>选择文件</button>
                    <button type="button" className="ban2note-upload-btn ban2note-upload-btn--outline" onClick={openFolderPicker}>选择文件夹</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* PVI 计算 */}
          <div className="ban2note-field ban2note-field--divider">
            <div className="ban2note-pvi">
              <label className="ban2note-pvi-inline-label">起始TP</label>
              <input className="ban2note-input ban2note-input--compact" value={startTP} onChange={e => setStartTP(e.target.value)} placeholder="0" />
              <label className="ban2note-pvi-inline-label">终止TP</label>
              <input className="ban2note-input ban2note-input--compact" value={endTP} onChange={e => setEndTP(e.target.value)} placeholder="0" />
              <button
                type="button"
                className="ban2note-pvi-btn"
                onClick={() => {
                    if (stats) {
                    const s = parseFloat(startTP) || 0;
                    const e = parseFloat(endTP) || 0;
                    // ============================================================
                    // ⚠ PVI 计算公式 —— 改这里前请三思，别再乘 100！
                    // ------------------------------------------------------------
                    // 正确：PVI = TP变化 / 游戏抽水，商本身就是百分数值。
                    //   例 TP差6400 / 抽水64.3 = 99.53，显示层拼 "%" → 99.53%。
                    // 历史 bug：曾被误加 *100（来源：d012788「13个bug」提交 + 误读 spec
                    //   `BAN2NOTE_PARSER_SPEC.md:805` 字面的 ×100），导致系统性偏大 100 倍
                    //   （99.53% 显示成 9953%）。spec 该条已过时，以此处为准。
                    // 记住：算一次除法即可，不要 ×100，显示层已经负责拼 %。
                    // ============================================================
                    const rake = stats.totalHeroRake;
                    if (rake > 0) setPVI((e - s) / rake);
                    else setPVI(0);
                  }
                }}
              >计算 PVI</button>
            </div>
          </div>

          {/* 筛选：级别支持多选并真实过滤数据，位置仅占位 */}
          <div className="ban2note-field">
            <div className="ban2note-filter-col">
              <span className="ban2note-filter-title">级别</span>
              <div className="ban2note-chips">
                <button
                  type="button"
                  className={`ban2note-chip ban2note-chip--all${stakeFilters.length === 0 ? " ban2note-chip--active" : ""}`}
                  onClick={() => setStakeFilters([])}
                >全部</button>
                {availableStakes.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`ban2note-chip${stakeFilters.includes(s) ? " ban2note-chip--active" : ""}`}
                    onClick={() => setStakeFilters((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])}
                  >{s}</button>
                ))}
              </div>
            </div>
            <div className="ban2note-filter-col">
              <span className="ban2note-filter-title">位置</span>
              <div className="ban2note-chips">
                <button
                  type="button"
                  className={`ban2note-chip ban2note-chip--all${positionFilter === null ? " ban2note-chip--active" : ""}`}
                  onClick={() => setPositionFilter(null)}
                >全部</button>
                {availablePositions.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`ban2note-chip${positionFilter === p ? " ban2note-chip--active" : ""}`}
                    onClick={() => setPositionFilter(positionFilter === p ? null : p)}
                  >{p}</button>
                ))}
              </div>
            </div>
            <div className="ban2note-filter-col">
              <span className="ban2note-filter-title">人数</span>
              <div className="ban2note-chips">
                <button
                  type="button"
                  className={`ban2note-chip ban2note-chip--all${seatCountFilters.length === 0 ? " ban2note-chip--active" : ""}`}
                  onClick={() => setSeatCountFilters([])}
                >全部</button>
                {availableSeatCounts.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`ban2note-chip${seatCountFilters.includes(n) ? " ban2note-chip--active" : ""}`}
                    onClick={() => setSeatCountFilters((prev) => prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n])}
                  >{n}</button>
                ))}
              </div>
            </div>
            <div className="ban2note-filter-col">
              <span className="ban2note-filter-title">日期</span>
              <div className="ban2note-chips">
                <button
                  type="button"
                  className={`ban2note-chip ban2note-chip--all${dateRange === null ? " ban2note-chip--active" : ""}`}
                  onClick={() => setDateRange(null)}
                >全部</button>
                {DATE_FILTERS.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    className={`ban2note-chip${dateRange === d.key ? " ban2note-chip--active" : ""}`}
                    onClick={() => setDateRange(dateRange === d.key ? null : d.key)}
                  >{d.label}</button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* 会员弹窗：常驻挂载（fixed 定位），不放进任何条件渲染分支 */}
        <CloudPanel
          open={cloudOpen}
          onClose={() => setCloudOpen(false)}
          me={me}
          onMeChange={handleMeChange}
          onLoadFiles={loadCloudFiles}
          parseLoading={loading}
        />

        {/* 存云命名弹层：必须过一次命名（预填默认名）才真正上传 */}
        {saveAsk && (
          <div className="b2rp-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setSaveAsk(false); }}>
            <div className="b2rp-panel b2c-saveask" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="命名并存储">
              <div className="b2rp-head">
                <span className="b2rp-title">存到云端 · 给这批手牌起个名</span>
                <button type="button" className="ban2-share-close" onClick={() => setSaveAsk(false)} aria-label="关闭">×</button>
              </div>
              <div className="b2c-saveask-body">
                <input
                  className="b2c-input"
                  value={saveName}
                  autoFocus
                  maxLength={60}
                  placeholder="1-60 字，如：11月GG-NL50"
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void doSaveCloud(); }}
                />
                <p className="b2c-note">共 {parsedHands.length.toLocaleString()} 手 · 名字以后可随时在「我的手牌库」里改</p>
                <button type="button" className="b2c-primary" disabled={!saveName.trim() || cloudSave.phase === "saving"} onClick={doSaveCloud}>
                  {cloudSave.phase === "saving" ? "存云中…" : "确认存储"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 右侧：结果区 */}
        <main className="ban2note-main">
          {!stats ? (
            <div className="ban2note-placeholder">
              <img className="ban2note-placeholder-mark" src="/brand/qiansuan-mark.svg" alt="" aria-hidden="true" />
              <svg className="ban2note-placeholder-art" viewBox="0 0 120 120" fill="none" aria-hidden="true">
                <path d="M10 95 L35 70 L55 80 L75 40 L110 20" stroke="#a88b46" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="110" cy="20" r="4" fill="#a88b46" />
                <line x1="10" y1="100" x2="115" y2="100" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
              </svg>
              <div className="ban2note-placeholder-text">还没有数据</div>
              <div className="ban2note-placeholder-sub">把 GGPoker / CoinPoker 牌谱拖到左侧，这里会生成你的资金曲线</div>
            </div>
          ) : (
            <>
              {/* 分页切换：数据页 ↔ 运气页 ↔ 翻前对比GTO（详细数据 tab 暂时隐藏） */}
              <div className="ban2note-pager">
                <button
                  type="button"
                  className={`ban2note-pager-btn${rightPage === "data" ? " ban2note-pager-btn--active" : ""}`}
                  onClick={() => setRightPage("data")}
                >数据总览</button>
                <button
                  type="button"
                  className={`ban2note-pager-btn${rightPage === "luck" ? " ban2note-pager-btn--active" : ""}`}
                  onClick={() => setRightPage("luck")}
                >运气如何</button>
                <button
                  type="button"
                  className={`ban2note-pager-btn${rightPage === "profit" ? " ban2note-pager-btn--active" : ""}`}
                  onClick={() => setRightPage("profit")}
                >盈利矩阵</button>
                <button
                  type="button"
                  className={`ban2note-pager-btn${rightPage === "handlog" ? " ban2note-pager-btn--active" : ""}`}
                  onClick={() => setRightPage("handlog")}
                >查看牌谱</button>
                <button
                  type="button"
                  className={`ban2note-pager-btn${rightPage === "gto" ? " ban2note-pager-btn--active" : ""}`}
                  onClick={() => setRightPage("gto")}
                >翻前对比GTO</button>
              </div>

              <ShareModal
                open={shareOpen}
                onClose={() => setShareOpen(false)}
                rows={buildStatRows(stats, pvi)}
                posCards={sharePosCards}
                chartCanvas={canvasRef.current}
                defaultId={uploadMeta?.firstName ?? ""}
              />

              {rightPage === "data" ? (
                <>
                  {/* 数据卡片三行 dense 8 列（盈利$ / 曲线终点三卡+百手 / 频率指标）+ 位置行 */}
                  <div className="ban2-stat-rows">
                    {buildStatRows(stats, pvi, evPending).map((row, rowIdx) => (
                      <div key={rowIdx} className={`ban2-stat-row ban2-stat-row--dense${rowIdx === 2 ? " ban2-stat-row--freq" : ""}`}>
                        {row.map((s, i) => (
                          <StatCard key={s.title || `blank-${rowIdx}-${i}`} {...s} />
                        ))}
                      </div>
                    ))}
                    <PositionCardsRow hands={filteredHands} />
                  </div>

                  {/* 盈利曲线（分享按钮浮在右下角，不动 tab 行） */}
                  <div className="card ban2-chart ban2-chart--share">
                    <canvas ref={canvasRef} className="ban2-chart-canvas" />
                    <div className="curve-legend" role="group" aria-label="曲线显隐">
                      {([
                        { key: "pre", color: "#22c55e", text: "总盈亏" },
                        { key: "net", color: COLOR_NET, text: "水后盈亏" },
                        { key: "ev", color: COLOR_EV, text: evPending ? "EV 计算中…" : "EV" },
                        { key: "nsd", color: "#ef4444", text: "非摊牌" },
                        { key: "sd", color: "#3b82f6", text: "摊牌" },
                      ] as const).map((it) => (
                        <label key={it.key} className="curve-legend-item">
                          <input
                            type="checkbox"
                            checked={curveVis[it.key]}
                            disabled={it.key === "ev" && evPending}
                            onChange={() => setCurveVis((v) => ({ ...v, [it.key]: !v[it.key] }))}
                          />
                          <span className="curve-legend-swatch" style={{ background: it.color }} />
                          <span>{it.text}</span>
                        </label>
                      ))}
                    </div>
                    <button type="button" className="ban2note-share-btn ban2note-share-btn--float" onClick={() => setShareOpen(true)}>
                      一键分享
                    </button>
                  </div>
                </>
              ) : rightPage === "luck" ? (
                /* 运气如何：运气指标 + 波动预估 */
                <>
                  <LuckPanel luckStats={luckStats} />
                  <VariancePanel stats={stats} netData={netData} loading={loading} />
                </>
              ) : rightPage === "profit" ? (
                /* 盈利矩阵：13×13 起手牌净盈利矩阵 + 组合详情 */
                <ProfitMatrixPanel hands={filteredHands} />
              ) : rightPage === "handlog" ? (
                /* 查看牌谱：逐手牌谱表 + 单手回放 */
                <HandLogPanel hands={filteredHands} />
              ) : rightPage === "detail" ? (
                /* 详细数据：HM3/PT4 风格 stats 矩阵 */
                <DetailStats stats={stats} />
              ) : (
                /* 对比GTO：逐位置 PFR 范围 vs GTO 基准，delta 矩阵 */
                <GtoComparePanel hands={filteredHands} />
              )}
            </>
          )}
        </main>
      </div>

      <footer className="ban2note-footer">
        <p className="ban2note-footer-note">
          © {new Date().getFullYear()} BanSolver · 梅小板联系微信 muston549 欢迎提建议找bug
          {" · "}
          <Link href="/en/tools/ban2note">English</Link>
        </p>
      </footer>
    </div>
  );
}
