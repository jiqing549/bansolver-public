"use client";

/* ================================================================
   盈利矩阵 — 13×13 起手牌净盈利矩阵 + 右侧组合详情
   ================================================================
   左：13×13 矩阵（对角=口袋对、右上=同花、左下=非同花），每格显示
       该组合的累计水后净盈利（bb），色阶按有样本组合 |净盈利| 的
       95 分位归一；
   右：点击格子弹出该组合的盈利明细（总览 + 按位置 + 翻前动作 +
       逐手明细），逐手明细里点任意一手弹出该手的回放窗口。

   数据随 ban2note 侧栏筛选（级别/位置/人数/日期）实时联动。
   ================================================================ */

import { useMemo, useState } from "react";
import type { ParsedHand } from "@/lib/hhTypes";
import {
  aggregateByCombo,
  aggPositionsByCombo,
  aggPreflopActionsByCombo,
  handListByCombo,
  PREFLOP_ACT_DEFS,
  type ComboAgg,
  type ComboHandItem,
} from "./profitMatrix";
import HandReplayModal, { type ReplayRowData } from "./HandReplayModal";

interface Props {
  hands: ParsedHand[];
}

// 数值格式化：保留 1 位小数，正数带 +、负数带 -
function fmtNet(v: number): string {
  const n = Math.round(v * 10) / 10;
  return (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(n);
}

function fmtPct(part: number, total: number): string {
  return total > 0 ? Math.round((part / total) * 1000) / 10 + "%" : "—";
}

function netCls(v: number): string {
  return v >= 0 ? " ban2note-hands-up" : " ban2note-hands-down";
}

// 矩阵行列序：A 在最上/最左，与 GTO range 矩阵一致
const RANK_ORDER = "AKQJT98765432";

// 色阶：负红正绿，透明度按 |净盈利|/scale 增强
function pnlBg(norm: number): string {
  const n = Math.min(1, Math.abs(Number.isFinite(norm) ? norm : 0));
  if (n < 0.005) return "rgba(255,255,255,0.04)";
  return norm < 0
    ? `rgba(239,68,68,${0.12 + 0.78 * n})`
    : `rgba(34,197,94,${0.12 + 0.78 * n})`;
}

function pnlFg(norm: number): string {
  const n = Math.min(1, Math.abs(Number.isFinite(norm) ? norm : 0));
  if (n < 0.05) return "rgba(255,255,255,0.28)";
  return n > 0.45 ? "rgba(20,20,20,0.92)" : "rgba(255,255,255,0.78)";
}

// 逐手明细里的日期缩写：「2026/01/05 12:03:00」→「01-05 12:03」；解析不出来就原样显示
function shortDate(date: string): string {
  const m = String(date || "").match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : date || "—";
}

function StatCell({ label, value, valueCls }: { label: string; value: string; valueCls?: string }) {
  return (
    <div className="ban2note-pnl-stat">
      <span className="ban2note-pnl-stat-label">{label}</span>
      <span className={"ban2note-pnl-stat-value" + (valueCls || "")}>{value}</span>
    </div>
  );
}

/** 右侧组合详情卡：展示被点选组合的盈利明细（总览 + 分位置 + 翻前动作 + 逐手明细）。 */
function ComboDetail({ sel, aggs, posMap, actMap, handsMap, total, onClear, onReplay }: {
  sel: string | null;
  aggs: ComboAgg[];
  posMap: ReturnType<typeof aggPositionsByCombo>;
  actMap: ReturnType<typeof aggPreflopActionsByCombo>;
  handsMap: ReturnType<typeof handListByCombo>;
  total: number;
  onClear: () => void;
  // list/index 供回放弹窗按当前明细排序顺序翻页
  onReplay: (row: ReplayRowData, list: ReplayRowData[], index: number) => void;
}) {
  // 逐手明细排序：默认按日期倒序；「按盈利」按钮循环切换 盈利高→低 / 盈利低→高 / 时间
  const [pnlSort, setPnlSort] = useState<"date" | "netDesc" | "netAsc">("date");
  const agg = sel ? aggs.find((a) => a.key === sel) ?? null : null;
  const handRows = useMemo(() => {
    const list: ComboHandItem[] = sel ? handsMap.get(sel) || [] : [];
    if (pnlSort === "date") return list;
    return [...list].sort((a, b) => (pnlSort === "netDesc" ? b.net - a.net : a.net - b.net));
  }, [sel, handsMap, pnlSort]);
  // 可回放的行（有原文）按当前展示顺序排好，连同 ord→下标 映射交给点击回调
  const replayRows = useMemo<ReplayRowData[]>(
    () => handRows
      .filter((h) => !!h.raw)
      .map((h) => ({ raw: h.raw, time: shortDate(h.date), stakes: h.stakes, pot: h.pot, cards: h.cards, heroWon: h.heroWon })),
    [handRows],
  );
  const replayOrdIndex = useMemo(() => {
    const m = new Map<number, number>();
    let k = 0;
    for (const h of handRows) {
      if (h.raw) m.set(h.ord, k++);
    }
    return m;
  }, [handRows]);
  const openAt = (h: ComboHandItem) => {
    const i = replayOrdIndex.get(h.ord);
    if (i == null) return;
    onReplay(replayRows[i], replayRows, i);
  };
  if (!sel) {
    return (
      <div className="ban2note-pnl-detail ban2note-pnl-detail--empty">
        <p className="ban2note-pnl-detail-title">手牌详情</p>
        <p className="ban2note-pnl-detail-hint">点击左侧矩阵里的任意手牌，这里会显示该组合的盈利明细。</p>
      </div>
    );
  }
  const per = agg ? agg.net / agg.hands : 0;
  const posRows = agg ? [...(posMap.get(sel) || new Map()).values()].sort((a, b) => b.hands - a.hands) : [];
  const actAgg = sel ? actMap.get(sel) || null : null;
  const actRows = actAgg
    ? PREFLOP_ACT_DEFS.map((d) => ({ key: d.key, label: d.label, ...actAgg.m[d.key] }))
    : [];
  const canReplay = !!onReplay;
  return (
    <div className="ban2note-pnl-detail">
      {/* 组合名不再单独一行：并入信息块置顶，× 跟在同行右侧 */}
      <div className="ban2note-pnl-detail-main">
        <div className="ban2note-pnl-detail-main-top">
          <span className="ban2note-pnl-detail-key">{sel}</span>
          <span className="ban2note-pnl-detail-cat">{agg ? agg.cat : "无样本"}</span>
          <button type="button" className="ban2note-pnl-detail-x" onClick={onClear} aria-label="清除选择">×</button>
        </div>
        {agg ? (
          <>
            <span className="ban2note-pnl-detail-main-label">净盈利 (bb)</span>
            <span className={"ban2note-pnl-detail-main-value" + netCls(agg.net)}>{fmtNet(agg.net)}</span>
            <span className="ban2note-pnl-detail-main-sub">{agg.hands} 手 · 每手 {fmtNet(per)} bb</span>
          </>
        ) : (
          <p className="ban2note-pnl-detail-hint">{sel} 这一格没有样本，暂时没有该组合的盈利数据。</p>
        )}
      </div>

      {agg ? (
        <div className="ban2note-pnl-stat-grid">
          <StatCell label="胜率" value={fmtPct(agg.won, agg.hands)} />
          <StatCell label="摊牌率" value={fmtPct(agg.show, agg.hands)} />
          <StatCell label="摊牌胜率" value={fmtPct(agg.showWon, agg.show)} />
          <StatCell label="翻牌率" value={fmtPct(agg.sawFlop, agg.hands)} />
          <StatCell label="占全部手数" value={fmtPct(agg.hands, total)} />
          <StatCell label="每手 (bb)" value={fmtNet(per)} valueCls={netCls(per)} />
        </div>
      ) : null}

      {agg && posRows.length > 0 ? (
        <div className="ban2note-pnl-pos-block">
          <p className="ban2note-pnl-detail-sub">按位置</p>
          <table className="ban2note-pnl-pos-table">
            <thead>
              <tr>{["位置", "手数", "胜率", "净盈利 (bb)"].map((h) => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {posRows.map((r) => (
                <tr key={r.key}>
                  <td className="ban2note-hands-key">{r.key}</td>
                  <td>{r.hands}</td>
                  <td>{fmtPct(r.won, r.hands)}</td>
                  <td className={"ban2note-hands-num" + netCls(r.net)}>{fmtNet(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {actRows.length > 0 ? (
        <div className="ban2note-pnl-act-block">
          <p className="ban2note-pnl-detail-sub">翻前动作</p>
          <table className="ban2note-pnl-pos-table">
            <thead>
              <tr>{["动作", "频率", "次数 / 机会", "净盈利 (bb)"].map((h) => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {actRows.map((r) => (
                <tr key={r.key}>
                  <td className="ban2note-hands-key">{r.label}</td>
                  <td>{fmtPct(r.h, r.opp)}</td>
                  <td>{r.h} / {r.opp}</td>
                  <td className={"ban2note-hands-num" + netCls(r.net)}>{fmtNet(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ban2note-pnl-act-note">
            「频率」的分母是该动作的机会数：跟注 open 与 3B 按「翻前面对 open 的手数」；跟注 3B 与 4B 按「面对 3B 的手数」；跟注 4B 按「面对 4B 的手数」；ALLIN 按「翻前面对加注的手数」；跟注 ALLIN 按「面对对手全下的手数」。净盈利为该动作真正发生那些手的水后净盈利合计（bb），机会数为 0 时频率显示「—」。
          </p>
        </div>
      ) : null}

      {handRows.length > 0 ? (
        <details className="ban2note-pnl-hands">
          <summary className="ban2note-pnl-hands-sum">
            逐手明细
            {canReplay ? <span className="ban2note-pnl-hands-hint">点某一行看该手回放</span> : null}
            <button
              type="button"
              className={"ban2note-pnl-hands-sort" + (pnlSort !== "date" ? " ban2note-pnl-hands-sort--active" : "")}
              title="切换排序：时间 → 盈利高→低 → 盈利低→高"
              onClick={(e) => {
                // 在 <summary> 内点击需阻止默认行为，否则会连带展开/收起
                e.preventDefault();
                setPnlSort((s) => (s === "date" ? "netDesc" : s === "netDesc" ? "netAsc" : "date"));
              }}
            >
              {pnlSort === "date" ? "按盈利" : pnlSort === "netDesc" ? "盈利 高→低 ▼" : "盈利 低→高 ▲"}
            </button>
            <span className="ban2note-pnl-hands-count">{handRows.length} 手</span>
          </summary>
          <div className="ban2note-pnl-hands-list">
            {handRows.map((h) => {
              const live = canReplay && !!h.raw;
              return (
                <div
                  key={h.id || h.ord}
                  className={`ban2note-pnl-hand${canReplay ? " ban2note-pnl-hand--click" : ""}${live ? " ban2note-pnl-hand--live" : ""}`}
                  role={live ? "button" : undefined}
                  tabIndex={live ? 0 : undefined}
                  title={live ? "点击查看这一手的牌谱回放" : undefined}
                  onClick={live ? () => openAt(h) : undefined}
                  onKeyDown={live ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openAt(h);
                    }
                  } : undefined}
                >
                  <span className="ban2note-pnl-hand-date">{shortDate(h.date)}</span>
                  <span className="ban2note-pnl-hand-pos">{h.pos}</span>
                  <span className="ban2note-pnl-hand-tag">{(h.won ? "赢" : "输") + (h.sd ? " · 摊牌" : "")}</span>
                  <span className={"ban2note-pnl-hand-net" + netCls(h.net)}>{fmtNet(h.net)}</span>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export default function ProfitMatrixPanel({ hands }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  // 回放态持有打开时的明细列表快照与当前下标：‹ › / ← → 沿该顺序翻页
  const [replay, setReplay] = useState<{ row: ReplayRowData; list: ReplayRowData[]; index: number } | null>(null);
  const openReplay = (row: ReplayRowData, list: ReplayRowData[], index: number) => setReplay({ row, list, index });
  const goReplay = (delta: number) => {
    setReplay((cur) => {
      if (!cur) return cur;
      const ni = cur.index + delta;
      if (ni < 0 || ni >= cur.list.length) return cur;
      return { row: cur.list[ni], list: cur.list, index: ni };
    });
  };

  const aggs = useMemo(() => aggregateByCombo(hands), [hands]);
  const posMap = useMemo(() => aggPositionsByCombo(hands), [hands]);
  const actMap = useMemo(() => aggPreflopActionsByCombo(hands), [hands]);
  const handsMap = useMemo(() => handListByCombo(hands), [hands]);

  // 矩阵：组合聚合铺回 13×13（与 comboLabel 的输出口径逐字一致，可直接按 key 命中）。
  // 色阶基准取「有样本组合 |净盈利| 的 95 分位」，避免个别极端组合把其余格子压成一片
  // 浅色；基数为 0（全部打平）时回退到最大绝对值，仍为 0 则整片走中性底。
  const matrix = useMemo(() => {
    const byKey = new Map(aggs.map((a) => [a.key, a]));
    const rows: { key: string; agg: ComboAgg | null }[][] = [];
    const absNets: number[] = [];
    for (let r = 0; r < 13; r++) {
      const row: { key: string; agg: ComboAgg | null }[] = [];
      for (let c = 0; c < 13; c++) {
        const key = r === c
          ? RANK_ORDER[r] + RANK_ORDER[r]
          : r < c
            ? RANK_ORDER[r] + RANK_ORDER[c] + "s"
            : RANK_ORDER[c] + RANK_ORDER[r] + "o";
        const agg = byKey.get(key) || null;
        row.push({ key, agg });
        if (agg) absNets.push(Math.abs(agg.net));
      }
      rows.push(row);
    }
    absNets.sort((a, b) => a - b);
    const p95 = absNets.length ? absNets[Math.min(absNets.length - 1, Math.floor(absNets.length * 0.95))] : 0;
    return {
      rows,
      scale: p95 > 0 ? p95 : absNets.length ? absNets[absNets.length - 1] : 0,
      n: absNets.length,
    };
  }, [aggs]);

  if (aggs.length === 0) {
    return (
      <div className="ban2note-placeholder">
        <div className="ban2note-placeholder-text">还没有数据</div>
        <div className="ban2note-placeholder-sub">上传牌谱后，这里会按起手牌统计你的盈利、胜率与摊牌表现</div>
      </div>
    );
  }

  const totalHands = aggs.reduce((s, a) => s + a.hands, 0);

  return (
    <div className="ban2note-hands">
      <div className="card ban2note-hands-block">
        <div className="ban2note-hands-head">
          <p className="ban2note-hands-title">盈利矩阵（感谢群友 信念🔥 贡献的代码）</p>
          <p className="ban2note-matrix-legend">
            <span><i style={{ background: "rgba(34,197,94,0.85)" }} />净盈利</span>
            <span><i style={{ background: "rgba(239,68,68,0.85)" }} />净亏损</span>
            <span>
              <i style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,.12)" }} />
              无样本
            </span>
          </p>
        </div>

        <div className="ban2note-pnl-wrap">
          <div className="ban2note-matrix ban2note-matrix--pnl">
            <div className="ban2note-matrix-grid" style={{ gridTemplateColumns: "auto repeat(13, 1fr)" }}>
              <div className="ban2note-matrix-corner" aria-hidden="true" />
              {RANK_ORDER.split("").map((r) => (
                <div key={`col-${r}`} className="ban2note-matrix-axis">{r}</div>
              ))}
              {matrix.rows.map((row, r) => [
                <div key={`rowh-${r}`} className="ban2note-matrix-axis ban2note-matrix-axis--row">{RANK_ORDER[r]}</div>,
                ...row.map((cell) => {
                  const agg = cell.agg;
                  // scale 为 0（选区内净盈利全为 0）时不做除法，避免 0/0=NaN 生成非法 CSS
                  const norm = agg && matrix.scale > 0 ? Math.max(-1, Math.min(1, agg.net / matrix.scale)) : 0;
                  const bg = agg ? pnlBg(norm) : "rgba(255,255,255,0.03)";
                  const fg = agg ? pnlFg(norm) : "rgba(255,255,255,0.22)";
                  return (
                    <div
                      key={cell.key}
                      className={
                        "ban2note-matrix-cell ban2note-matrix-cell--pnl" +
                        (agg ? "" : " ban2note-matrix-cell--none") +
                        (sel === cell.key ? " ban2note-matrix-cell--active" : "")
                      }
                      role="button"
                      tabIndex={0}
                      aria-pressed={sel === cell.key}
                      onClick={() => setSel((prev) => (prev === cell.key ? null : cell.key))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSel((prev) => (prev === cell.key ? null : cell.key));
                        }
                      }}
                      title={agg ? `${cell.key} · ${agg.hands} 手 · 净盈利 ${fmtNet(agg.net)} bb` : `${cell.key} · 无样本`}
                      style={{ background: bg, color: fg }}
                    >
                      <span className="ban2note-matrix-cell-key">{cell.key}</span>
                      <span className="ban2note-matrix-cell-val">{agg ? fmtNet(agg.net) : "—"}</span>
                    </div>
                  );
                }),
              ])}
            </div>
          </div>

          <ComboDetail
            sel={sel}
            aggs={aggs}
            posMap={posMap}
            actMap={actMap}
            handsMap={handsMap}
            total={totalHands}
            onClear={() => setSel(null)}
            onReplay={openReplay}
          />
        </div>
      </div>

      {replay ? (
        <HandReplayModal
          row={replay.row}
          onClose={() => setReplay(null)}
          posLabel={`${replay.index + 1} / ${replay.list.length}`}
          hasPrev={replay.index > 0}
          hasNext={replay.index < replay.list.length - 1}
          onPrev={() => goReplay(-1)}
          onNext={() => goReplay(1)}
        />
      ) : null}
    </div>
  );
}
