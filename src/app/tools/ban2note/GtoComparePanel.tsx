"use client";

/* 对比GTO 面板：每个位置一行，横向布局
 *   左：位置名 + 汇总数字（PFR% / GTO% / 差值）
 *   右：用户范围 / GTO 范围 / delta 三个矩阵并排
 *
 * GTO 基准来自站内翻前求解树（/tools/preflop 同源，见 gtoTree.ts）：
 *   RFI     gg-zoom-3bb（GTO 混合开注尺寸解：EP 2 / CO·BTN 2.5 / SB 3）
 *   BB 防守 开注尺寸 filter：默认(3bb 树) / 2BB / 2.5BB，档位同时切换
 *           GTO 树与用户手牌分桶（按 openRaiseToBB），保证同口径对比。
 *
 * delta 前端直接计算（无需后端）。
 * 数据随 ban2note 侧栏筛选（级别/位置/人数）实时联动。
 */

import { useState, useEffect } from "react";
import type { ParsedHand } from "@/lib/hhTypes";
import {
  buildUserPFRGrid,
  buildDeltaGrid,
  buildBBDefendGrid,
  heroPositionToSlot,
  nonZeroCount,
  overallFreq,
  applyThreshold,
  emptyGrid,
  USER_FREQ_THRESHOLD,
  BB_DEFEND_OPPS,
  type FreqGrid,
} from "./rangeMatrix";
import {
  BB_DEFEND_FILTERS,
  GTO_RFI_SLOTS,
  loadGtoTree,
  treeToRfiGrids,
  treeToBbDefendGrids,
  type GtoTreeId,
  type BbDefendExtract,
} from "./gtoTree";
import RangeMatrixView from "./RangeMatrixView";

interface Props {
  hands: ParsedHand[];
}

/** 单个位置的计算结果 */
interface SlotResult {
  slot: string;
  slotHands: ParsedHand[];
  userGrid: FreqGrid;
  sample: number[][];
  deltaGrid: FreqGrid;
  hasUserData: boolean;
  hasGtoData: boolean;
  gtoGrid: FreqGrid;
  userPct: number;
  gtoPct: number | null;
  diff: number | null;
}

/** BB 防守单个对手位置的计算结果 */
interface BBDefendResult {
  opp: string;            // 开池者位置（GTO 槽位，如 UTG/MP/CO/BTN/SB）
  openSize: number | null; // 当前树中该位置的开注尺寸（bb）
  hands: ParsedHand[];    // 该对手开池时 BB 的防守手牌（已按 filter 分桶）
  grid3bet: FreqGrid;
  gridCall: FreqGrid;
  deltaGridDefend: FreqGrid;  // Delta = 总防守率(3bet+call) user − gto
  sample: number[][];
  threebetPct: number;
  callPct: number;
  gto3betPct: number | null;
  gtoCallPct: number | null;
  diff3bet: number | null;
  diffCall: number | null;
  hasGtoData: boolean;
}

/* RFI 行 = 除 BB 外 5 个位置 */
const RFI_SLOTS: string[] = [...GTO_RFI_SLOTS];

type TreeState = {
  /** RFI 基准（3bb 树） */
  rfi: Record<string, FreqGrid> | null;
  /** 各树 BB 防守提取 */
  bb: Partial<Record<GtoTreeId, BbDefendExtract>>;
  errors: Partial<Record<GtoTreeId, string>>;
};

export default function GtoComparePanel({ hands }: Props) {
  // 计算结果（异步，后台刷新）
  const [results, setResults] = useState<SlotResult[]>([]);
  const [bbResults, setBbResults] = useState<BBDefendResult[]>([]);
  const [computing, setComputing] = useState(false);

  // ── 求解树加载（三套并行；模块级缓存，切 tab 重挂不重拉）──
  const [trees, setTrees] = useState<TreeState>({ rfi: null, bb: {}, errors: {} });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setTrees({ rfi: null, bb: {}, errors: {} });
    const ids: GtoTreeId[] = ["gg-zoom-3bb", "gg-zoom-2bb", "gg-zoom-2p5bb"];
    for (const id of ids) {
      loadGtoTree(id)
        .then((data) => {
          if (!alive) return;
          setTrees((prev) => ({
            rfi: id === "gg-zoom-3bb" ? treeToRfiGrids(data) : prev.rfi,
            bb: { ...prev.bb, [id]: treeToBbDefendGrids(data) },
            errors: prev.errors,
          }));
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setTrees((prev) => ({
            ...prev,
            errors: { ...prev.errors, [id]: e instanceof Error ? e.message : String(e) },
          }));
        });
    }
    return () => {
      alive = false;
    };
  }, [retryKey]);

  // ── BB 防守开注尺寸 filter ──
  const [bbFilter, setBbFilter] = useState<string>("def");
  const activeFilter = BB_DEFEND_FILTERS.find((f) => f.key === bbFilter) ?? BB_DEFEND_FILTERS[0];

  useEffect(() => {
    if (hands.length === 0) {
      setResults([]);
      setBbResults([]);
      return;
    }
    // 标记计算中，让其他 tab 先渲染，GTO 对比后台异步算
    setComputing(true);
    // 用 microtask 延迟一帧，让浏览器先完成主流程的渲染
    const id = setTimeout(() => {
      // 按 6-max 槽位分组手牌
      const bySlot = new Map<string, ParsedHand[]>();
      for (const h of hands) {
        const slot = heroPositionToSlot(h.heroPosition);
        if (!slot) continue;
        const arr = bySlot.get(slot);
        if (arr) arr.push(h);
        else bySlot.set(slot, [h]);
      }

      const rfiGrids = trees.rfi;
      const slotsToShow = RFI_SLOTS.filter(
        (s) => (bySlot.get(s)?.length ?? 0) > 0 || (rfiGrids?.[s] ? nonZeroCount(rfiGrids[s]) > 0 : false),
      );

      const computed: SlotResult[] = slotsToShow.map((slot) => {
        const slotHands = bySlot.get(slot) ?? [];
        const { grid: userGrid, sample } = buildUserPFRGrid(slotHands);
        const hasGtoData = !!rfiGrids?.[slot] && nonZeroCount(rfiGrids[slot]) > 0;
        const gtoGrid = rfiGrids?.[slot] ?? emptyGrid();
        const userGridForDelta = applyThreshold(userGrid, USER_FREQ_THRESHOLD);
        const deltaGrid = hasGtoData ? buildDeltaGrid(gtoGrid, userGridForDelta) : emptyGrid();
        const hasUserData = slotHands.length > 0;
        const userPct = overallFreq(userGrid);
        const gtoPct = hasGtoData ? overallFreq(gtoGrid) : null;
        const diff = gtoPct !== null ? userPct - gtoPct : null;
        return { slot, slotHands, userGrid, sample, deltaGrid, hasUserData, hasGtoData, gtoGrid, userPct, gtoPct, diff };
      });

      setResults(computed);

      // ── BB 防守：hero 在 BB 面对各位置单一 open raise 的防守 ──
      // 按开池者位置（映射到 GTO 槽位）分组，再按当前 filter 的开注尺寸分桶
      const treeDef = trees.bb[activeFilter.treeId] ?? null;
      const bbByOpp = new Map<string, ParsedHand[]>();
      for (const h of hands) {
        if (h.heroPosition !== "BB") continue;
        if (!h.facingRaise || h.squeezeOpp || h.isSqueeze) continue;
        if (h.limpersBeforeFirstRaise !== 0) continue;
        const oppSlot = heroPositionToSlot(h.openRaiserPos);
        if (!oppSlot || oppSlot === "BB") continue;
        // 开注尺寸分桶（默认档 bucket=null 全量）
        const b = activeFilter.bucket;
        if (b && (h.openRaiseToBB == null || h.openRaiseToBB <= b.lo || h.openRaiseToBB > b.hi)) continue;
        const arr = bbByOpp.get(oppSlot);
        if (arr) arr.push(h);
        else bbByOpp.set(oppSlot, [h]);
      }
      const bbComputed: BBDefendResult[] = BB_DEFEND_OPPS.filter(
        (opp) => (bbByOpp.get(opp)?.length ?? 0) > 0 || !!treeDef?.grids[opp],
      ).map((opp) => {
        const oppHands = bbByOpp.get(opp) ?? [];
        const { grid3bet, gridCall, sample } = buildBBDefendGrid(oppHands);
        const threebetPct = overallFreq(grid3bet);
        const callPct = overallFreq(gridCall);
        const hasGto = !!treeDef?.grids[opp];
        const gto3bet = treeDef?.grids[opp]?.grid3bet;
        const gtoCall = treeDef?.grids[opp]?.gridCall;
        // GTO 频率（树未就绪时为 null）
        const gto3betPct = hasGto ? overallFreq(gto3bet!) : null;
        const gtoCallPct = hasGto ? overallFreq(gtoCall!) : null;
        // Delta = 总防守率(3bet+call，封顶1) 逐格 user − gto
        const deltaGridDefend = emptyGrid();
        for (let r = 0; r < 13; r++) {
          for (let c = 0; c < 13; c++) {
            // 用户低频格归零（同 RFI 阈值处理）
            const u3 = grid3bet[r][c] < USER_FREQ_THRESHOLD ? 0 : grid3bet[r][c];
            const uc = gridCall[r][c] < USER_FREQ_THRESHOLD ? 0 : gridCall[r][c];
            const userTotal = Math.min(1, u3 + uc);
            const gtoTotal = hasGto ? Math.min(1, gto3bet![r][c] + gtoCall![r][c]) : 0;
            deltaGridDefend[r][c] = hasGto ? userTotal - gtoTotal : 0;
          }
        }
        return {
          opp,
          openSize: treeDef?.openSize[opp] ?? null,
          hands: oppHands, grid3bet, gridCall, deltaGridDefend, sample,
          threebetPct, callPct,
          gto3betPct, gtoCallPct,
          diff3bet: gto3betPct !== null ? threebetPct - gto3betPct : null,
          diffCall: gtoCallPct !== null ? callPct - gtoCallPct : null,
          hasGtoData: hasGto,
        };
      });
      setBbResults(bbComputed);

      setComputing(false);
    }, 0);

    return () => clearTimeout(id);
  }, [hands, trees, activeFilter]);

  // 树加载状态汇总
  const treeIds: GtoTreeId[] = ["gg-zoom-3bb", "gg-zoom-2bb", "gg-zoom-2p5bb"];
  const loadedCount = treeIds.filter((id) => trees.bb[id] || trees.errors[id]).length;
  const failedIds = treeIds.filter((id) => trees.errors[id]);

  if (hands.length === 0) {
    return (
      <div className="ban2note-gto-empty">
        <div className="ban2note-placeholder-text">还没有数据</div>
        <div className="ban2note-placeholder-sub">上传牌谱后，这里会逐位置对比你的 PFR 范围与 GTO 基准</div>
      </div>
    );
  }

  return (
    <div className="ban2note-gto">
      {/* 图例 */}
      <div className="ban2note-gto-legend card">
        <div className="ban2note-gto-legend-row">
          <span className="ban2note-gto-legend-swatch ban2note-gto-legend-swatch--gold" />
          <span>透明度 = 频率（越满越常开）</span>
          <span className="ban2note-gto-legend-sep" />
          <span className="ban2note-gto-legend-swatch ban2note-gto-legend-swatch--green" />
          <span>Delta 绿 = 你开了 GTO 不开（过度开牌）</span>
          <span className="ban2note-gto-legend-sep" />
          <span className="ban2note-gto-legend-swatch ban2note-gto-legend-swatch--red" />
          <span>Delta 红 = GTO 开但你没开（漏开）</span>
        </div>
        <div className="ban2note-gto-legend-note">
          用户范围 = 每个组合被发到时 RFI（无人入池首次加注）的频率；样本 &lt; 3 手的格子会淡化标注。
          GTO 基准来自站内翻前求解树（GG Zoom 6max · 100bb · 含抽水模型），RFI 为混合开注尺寸解（EP 开 2 · CO/BTN 开 2.5 · SB 开 3bb）。
        </div>
      </div>

      {/* 树加载状态 */}
      {failedIds.length > 0 && (
        <div className="ban2note-gto-treebar card">
          <span>
            GTO 求解树加载失败（{failedIds.length}/{treeIds.length}）：
            {failedIds.map((id) => trees.errors[id]).filter(Boolean).join("；")}
          </span>
          <button type="button" className="ban2note-gto-retry" onClick={() => setRetryKey((k) => k + 1)}>
            重试
          </button>
        </div>
      )}
      {loadedCount < treeIds.length && failedIds.length < treeIds.length && (
        <div className="ban2note-gto-treebar card">
          <span className="ban2note-gto-treebar-loading">GTO 基准加载中（{loadedCount}/{treeIds.length}）…</span>
        </div>
      )}

      {computing && results.length === 0 && (
        <div className="ban2note-gto-loading">
          <div className="ban2note-placeholder-text">正在计算 GTO 对比…</div>
          <div className="ban2note-placeholder-sub">其他数据已就绪，这里马上出来</div>
        </div>
      )}

      {results.map((res) => (
        <section key={res.slot} className="ban2note-pos-row card">
          {/* 左：位置信息 + 汇总数字 */}
          <div className="ban2note-pos-meta">
            <h3 className="ban2note-pos-title">{res.slot}</h3>
            <span className="ban2note-pos-count">
              {res.hasUserData ? `${res.slotHands.length} 手` : "无手牌数据"}
            </span>
            <dl className="ban2note-pos-freqs">
              <div className="ban2note-pos-freq">
                <dt>RFI</dt>
                <dd>{(res.userPct * 100).toFixed(1)}%</dd>
              </div>
              <div className="ban2note-pos-freq">
                <dt>GTO</dt>
                <dd>{res.gtoPct !== null ? `${(res.gtoPct * 100).toFixed(1)}%` : "—"}</dd>
              </div>
              <div className={`ban2note-pos-freq${res.diff !== null && res.diff < -0.01 ? " ban2note-pos-freq--lo" : ""}${res.diff !== null && res.diff > 0.01 ? " ban2note-pos-freq--hi" : ""}`}>
                <dt>差值</dt>
                <dd>
                  {res.diff !== null
                    ? (Math.abs(res.diff) < 0.01 ? `<1%` : `${res.diff >= 0 ? "+" : ""}${(res.diff * 100).toFixed(0)}%`)
                    : "—"}
                </dd>
              </div>
            </dl>
            <div className="ban2note-pos-hint">
              {!trees.rfi
                ? failedIds.length > 0 ? "GTO 树加载失败" : "GTO 树加载中…"
                : res.diff !== null && res.diff < -0.01 ? "你开得太紧（漏开）"
                  : res.diff !== null && res.diff > 0.01 ? "你开得太松（过度）"
                    : res.diff !== null ? "开牌范围接近 GTO"
                      : "GTO 待补"}
            </div>
          </div>

          {/* 右：三个矩阵横向并排 */}
          <div className="ban2note-pos-matrices">
            <div className="ban2note-pos-matrix">
              <div className="ban2note-pos-matrix-label">用户范围（RFI）</div>
              <RangeMatrixView grid={res.userGrid} mode="user" sample={res.sample} />
            </div>
            <div className="ban2note-pos-matrix">
              <div className="ban2note-pos-matrix-label">GTO 范围</div>
              {res.hasGtoData ? (
                <RangeMatrixView grid={res.gtoGrid} mode="gto" />
              ) : (
                <div className="ban2note-pos-matrix-pending">
                  {trees.rfi ? "GTO 数据待补" : failedIds.length > 0 ? "GTO 树加载失败" : "GTO 树加载中…"}
                </div>
              )}
            </div>
            <div className="ban2note-pos-matrix">
              <div className="ban2note-pos-matrix-label">Delta（用户 − GTO）</div>
              {res.hasGtoData ? (
                <RangeMatrixView grid={res.deltaGrid} mode="delta" sample={res.sample} />
              ) : (
                <div className="ban2note-pos-matrix-pending">树就绪后生效</div>
              )}
            </div>
          </div>
        </section>
      ))}

      {/* ── BB 防守分区 ── */}
      {bbResults.length > 0 && (
        <>
          <div className="ban2note-gto-section-title">
            BB 防守范围（面对开池）
            <span className="ban2note-gto-filter">
              {BB_DEFEND_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`ban2note-gto-filter-btn${bbFilter === f.key ? " is-on" : ""}`}
                  onClick={() => setBbFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </span>
          </div>
          <div className="ban2note-gto-legend-note ban2note-gto-legend-note--defend">
            用户/GTO 图：透明度 = 3bet+call 总占比；红格 = 3bet ≥ 10%，金格 = 3bet &lt; 10%（以 call 为主，与上方 RFI 金色一致）。Delta 图 = 总防守率(3bet+call) 偏差，红=防守不足，绿=过度防守。仅统计 BB 面对单一 open raise（排除 limp / squeeze / 4bet 池）。
            {activeFilter.bucket
              ? `当前档位只统计对手实际开注 ${(activeFilter.bucket.lo === 0 ? "" : activeFilter.bucket.lo + "~")}${activeFilter.bucket.hi}bb 的手牌，GTO 取对应单开注尺寸解。`
              : "默认档统计全部开注尺寸，GTO 取混合尺寸解（EP 开 2 · CO/BTN 开 2.5 · SB 开 3bb）。"}
          </div>
          {bbResults.map((res) => (
            <section key={`bb-${res.opp}`} className="ban2note-pos-row card">
              <div className="ban2note-pos-meta">
                <h3 className="ban2note-pos-title">
                  BB vs {res.opp}
                  {res.openSize !== null && (
                    <span className="ban2note-pos-opensize">开 {res.openSize}bb</span>
                  )}
                </h3>
                <span className="ban2note-pos-count">
                  {res.hands.length > 0 ? `${res.hands.length} 手` : "无手牌数据"}
                </span>
                <dl className="ban2note-pos-freqs">
                  <div className="ban2note-pos-freq">
                    <dt>3bet</dt>
                    <dd>{(res.threebetPct * 100).toFixed(1)}%</dd>
                  </div>
                  <div className="ban2note-pos-freq">
                    <dt>GTO</dt>
                    <dd>{res.gto3betPct !== null ? `${(res.gto3betPct * 100).toFixed(1)}%` : "—"}</dd>
                  </div>
                  <div className={`ban2note-pos-freq${res.diff3bet !== null && res.diff3bet < -0.01 ? " ban2note-pos-freq--lo" : ""}${res.diff3bet !== null && res.diff3bet > 0.01 ? " ban2note-pos-freq--hi" : ""}`}>
                    <dt>差值</dt>
                    <dd>
                      {res.diff3bet !== null
                        ? (Math.abs(res.diff3bet) < 0.001 ? `<1%` : `${res.diff3bet >= 0 ? "+" : ""}${(res.diff3bet * 100).toFixed(0)}%`)
                        : "—"}
                    </dd>
                  </div>
                  <div className="ban2note-pos-freq">
                    <dt>Call</dt>
                    <dd>{(res.callPct * 100).toFixed(1)}%</dd>
                  </div>
                  <div className="ban2note-pos-freq">
                    <dt>GTO</dt>
                    <dd>{res.gtoCallPct !== null ? `${(res.gtoCallPct * 100).toFixed(1)}%` : "—"}</dd>
                  </div>
                  <div className={`ban2note-pos-freq${res.diffCall !== null && res.diffCall < -0.01 ? " ban2note-pos-freq--lo" : ""}${res.diffCall !== null && res.diffCall > 0.01 ? " ban2note-pos-freq--hi" : ""}`}>
                    <dt>差值</dt>
                    <dd>
                      {res.diffCall !== null
                        ? (Math.abs(res.diffCall) < 0.001 ? `<1%` : `${res.diffCall >= 0 ? "+" : ""}${(res.diffCall * 100).toFixed(0)}%`)
                        : "—"}
                    </dd>
                  </div>
                </dl>
                <div className="ban2note-pos-hint">
                  {!(trees.bb[activeFilter.treeId])
                    ? failedIds.length > 0 ? "GTO 树加载失败" : "GTO 树加载中…"
                    : res.diff3bet !== null && res.diff3bet < -0.01 ? "你 3bet 太少（偏紧）"
                      : res.diff3bet !== null && res.diff3bet > 0.01 ? "你 3bet 太多（偏激进）"
                        : res.diff3bet !== null ? "3bet 频率接近 GTO"
                          : "GTO 待补"}
                </div>
              </div>
              <div className="ban2note-pos-matrices">
                <div className="ban2note-pos-matrix">
                  <div className="ban2note-pos-matrix-label">用户防守（3bet / call）</div>
                  <RangeMatrixView grid={res.grid3bet} gridCall={res.gridCall} mode="defend" sample={res.sample} />
                </div>
                <div className="ban2note-pos-matrix">
                  <div className="ban2note-pos-matrix-label">GTO 防守（3bet / call）</div>
                  {res.hasGtoData ? (
                    <RangeMatrixView
                      grid={trees.bb[activeFilter.treeId]!.grids[res.opp].grid3bet}
                      gridCall={trees.bb[activeFilter.treeId]!.grids[res.opp].gridCall}
                      mode="defend"
                    />
                  ) : (
                    <div className="ban2note-pos-matrix-pending">
                      {trees.bb[activeFilter.treeId] ? `BB vs ${res.opp} GTO 数据待补` : failedIds.length > 0 ? "GTO 树加载失败" : "GTO 树加载中…"}
                    </div>
                  )}
                </div>
                <div className="ban2note-pos-matrix">
                  <div className="ban2note-pos-matrix-label">Delta（总防守率 用户 − GTO）</div>
                  {res.hasGtoData ? (
                    <RangeMatrixView grid={res.deltaGridDefend} mode="delta" sample={res.sample} />
                  ) : (
                    <div className="ban2note-pos-matrix-pending">树就绪后生效</div>
                  )}
                </div>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
