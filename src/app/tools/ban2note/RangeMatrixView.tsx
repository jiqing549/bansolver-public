"use client";

/* 只读 13×13 频率矩阵。透明度 = 频率。
 * user/gto：金色调，α = 频率（0 空 / 1 满）
 * delta = 用户 − GTO：<0 红（漏开，用户比 GTO 少开）；>0 绿（过度，用户比 GTO 多开），α = |delta|
 * defend：BB 防守合并矩阵——3bet 满色红（α=3bet频率），call 半透明橙（α=call频率）。
 *         同格两者皆有时，先铺 call 橙底，再叠 3bet 红（3bet 视觉优先）。
 */

import {
  RANKS,
  GRID_N,
  cellLabel,
  type FreqGrid,
} from "./rangeMatrix";

export type MatrixMode = "user" | "gto" | "delta" | "defend";

interface Props {
  grid: FreqGrid;
  mode: MatrixMode;
  /** defend 模式下的 call 频率矩阵（3bet 用 grid） */
  gridCall?: FreqGrid;
  /** user/delta/defend 模式下每格的样本数（用于淡化样本过小的格子） */
  sample?: number[][];
}

// 频率 → 背景色
function cellBg(mode: MatrixMode, freq: number): string {
  const a = Math.min(1, Math.abs(freq));
  if (mode === "delta") {
    // delta ≈ 0（|delta| < 0.5%）：极淡中性灰，区别于「无数据」的透明
    if (a < 0.005) return "rgba(255,255,255,0.04)";
    return freq < 0
      ? `rgba(239,68,68,${0.12 + a * 0.78})` // 红：漏开（用户 < GTO）
      : `rgba(34,197,94,${0.12 + a * 0.78})`; // 绿：过度（用户 > GTO）
  }
  // user / gto：金色
  if (a < 0.001) return "transparent";
  return `rgba(196,164,85,${0.12 + a * 0.8})`;
}

// 频率 → 文字颜色（深色格子用浅字，浅格子用暗字，保证可读）
function cellFg(mode: MatrixMode, freq: number): string {
  const a = Math.min(1, Math.abs(freq));
  if (a < 0.05) return "rgba(255,255,255,0.28)";
  return a > 0.45 ? "rgba(20,20,20,0.92)" : "rgba(255,255,255,0.78)";
}

export default function RangeMatrixView({ grid, mode, gridCall, sample }: Props) {
  return (
    <div className="ban2note-matrix" role="table" aria-label={`${mode} range matrix`}>
      <div
        className="ban2note-matrix-grid"
        style={{ gridTemplateColumns: `auto repeat(${GRID_N}, 1fr)` }}
      >
        {/* 表头列标 */}
        <div className="ban2note-matrix-corner" />
        {RANKS.split("").map((r) => (
          <div key={`h-${r}`} className="ban2note-matrix-axis">{r}</div>
        ))}

        {RANKS.split("").map((rChar, r) => (
          // 用 Fragment 包行标+单元格，避免 key 警告
          <RowFragment
            key={`row-${r}`}
            r={r}
            rChar={rChar}
            grid={grid}
            mode={mode}
            gridCall={gridCall}
            sample={sample}
          />
        ))}
      </div>
    </div>
  );
}

function RowFragment({
  r,
  rChar,
  grid,
  mode,
  gridCall,
  sample,
}: {
  r: number;
  rChar: string;
  grid: FreqGrid;
  mode: MatrixMode;
  gridCall?: FreqGrid;
  sample?: number[][];
}) {
  return (
    <>
      <div className="ban2note-matrix-axis ban2note-matrix-axis--row">{rChar}</div>
      {RANKS.split("").map((cChar, c) => {
        const freq = grid[r][c] ?? 0;
        const n = sample?.[r]?.[c] ?? 0;
        const label = cellLabel(r, c);
        // user/delta/defend 都淡化样本 < 3 的格子
        const tooFew = mode !== "gto" && sample && n > 0 && n < 3;
        // delta 模式下，用户该组合无样本 → 黑色跳过格
        const skip = mode === "delta" && sample && n === 0;
        let title: string;
        let bg: string;
        let fg: string;
        if (mode === "defend") {
          const callFreq = gridCall?.[r]?.[c] ?? 0;
          const a3 = Math.min(1, freq);
          const ac = Math.min(1, callFreq);
          bg = defendBg(ac, a3);
          fg = defendFg(ac, a3);
          title = `${label} · 3bet ${(freq * 100).toFixed(0)}% / call ${(callFreq * 100).toFixed(0)}% · 样本 ${n} 手${tooFew ? "（样本过少）" : ""}`;
        } else if (mode === "user") {
          title = `${label} · 频率 ${(freq * 100).toFixed(0)}% · 样本 ${n} 手${tooFew ? "（样本过少）" : ""}`;
          bg = cellBg(mode, freq);
          fg = cellFg(mode, freq);
        } else if (mode === "gto") {
          title = `${label} · GTO 开牌 ${(freq * 100).toFixed(0)}%`;
          bg = cellBg(mode, freq);
          fg = cellFg(mode, freq);
        } else {
          // delta
          title = skip
            ? `${label} · 无样本（跳过）`
            : `${label} · Delta ${(freq >= 0 ? "+" : "")}${(freq * 100).toFixed(0)}% · 样本 ${n} 手${tooFew ? "（样本过少）" : ""}`;
          bg = skip ? "#000" : cellBg(mode, freq);
          fg = skip ? "rgba(255,255,255,0.18)" : cellFg(mode, freq);
        }
        return (
          <div
            key={`${r}-${c}`}
            className={`ban2note-matrix-cell${tooFew ? " ban2note-matrix-cell--sparse" : ""}${skip ? " ban2note-matrix-cell--skip" : ""}`}
            title={title}
            style={{ background: bg, color: fg }}
          >
            {label}
          </div>
        );
      })}
    </>
  );
}

/** defend 模式：
 *  - 透明度 = 总防守率（3bet + call，封顶 1）
 *  - 3bet < 10% → 纯金色（与 RFI cellBg 同公式，绝大多数 call 格）
 *  - 3bet ≥ 10% → 染红（3bet 明显的格子，即使同时有 call 也显红） */
function defendBg(callFreq: number, threebetFreq: number): string {
  const total = Math.min(1, callFreq + threebetFreq);
  if (total < 0.001) return "transparent";
  const alpha = 0.12 + total * 0.8; // 总占比决定透明度，与 RFI 同公式
  if (threebetFreq >= 0.1) {
    return `rgba(239,68,68,${alpha})`; // 3bet 明显：红
  }
  return `rgba(196,164,85,${alpha})`; // 3bet < 10%：纯金（与 RFI 一致）
}

function defendFg(callFreq: number, threebetFreq: number): string {
  const a = Math.min(1, callFreq + threebetFreq); // 与背景透明度同基准（总占比）
  if (a < 0.05) return "rgba(255,255,255,0.28)";
  return a > 0.45 ? "rgba(20,20,20,0.92)" : "rgba(255,255,255,0.78)";
}
