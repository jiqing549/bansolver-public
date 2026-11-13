/* ================================================================
   ban2note · 对比GTO —— 求解树数据源
   ----------------------------------------------------------------
   从 /tools/preflop 的求解树 JSON（trainerLogic 同一套数据）提取两块
   GTO 基准，输出与 rangeMatrix.parseFreqRange 同形的 FreqGrid（13×13）：

     ① RFI 开池范围   treeToRfiGrids
        各位置 RFI 决策节点（"Fold"×i，i=0..4 对应 UTG..SB）里
        全部加注动作的逐手频率之和。
     ② BB 面对开池防守 treeToBbDefendGrids
        open 后其余位置全部弃牌、轮到 BB 的决策节点
        （"Fold"×i + open动作 + "/Fold"×(4-i)）：
        grid3bet = 加注类动作频率之和，gridCall = Call 动作频率。

   三套 6max 100bb 树对应 BB 防守开注尺寸 filter：
     默认   gg-zoom-3bb   —— GTO 混合尺寸解（UTG/MP 开 2、CO/BTN 开 2.5、SB 开 3）
     2BB    gg-zoom-2bb   —— 全位置固定开 2bb 单尺寸解
     2.5BB  gg-zoom-2p5bb —— 全位置固定开 2.5bb 单尺寸解
   ================================================================ */

import {
  type PfData,
  type PfNode,
  fetchSolutionWithRetry,
  freqAt,
  PF_SOLUTION_URLS,
} from "../preflop/trainerLogic";
import { RANKS, emptyGrid, type FreqGrid } from "./rangeMatrix";

/* 与 rangeMatrix.BB_DEFEND_OPPS 一致的 5 个非盲注位（也是 RFI 位） */
export const GTO_RFI_SLOTS = ["UTG", "MP", "CO", "BTN", "SB"] as const;

export type GtoTreeId = "gg-zoom-3bb" | "gg-zoom-2bb" | "gg-zoom-2p5bb";

/** filter 档位定义：显示名 + 树 id + 用户手牌按 openRaiseToBB 的分桶边界 */
export const BB_DEFEND_FILTERS: {
  key: string;
  label: string;
  treeId: GtoTreeId;
  /** null = 全量（默认档，同旧口径）；否则保留 openRaiseToBB 落在 [lo, hi] 的手 */
  bucket: { lo: number; hi: number } | null;
}[] = [
  { key: "def", label: "默认（3BB 树）", treeId: "gg-zoom-3bb", bucket: null },
  { key: "2bb", label: "2BB 开池", treeId: "gg-zoom-2bb", bucket: { lo: 0, hi: 2.2 } },
  { key: "2p5", label: "2.5BB 开池", treeId: "gg-zoom-2p5bb", bucket: { lo: 2.2, hi: 2.7 } },
];

/* ---- 树加载：模块级 Promise 缓存（组件重挂不重拉；失败可重试）---- */
const treeCache = new Map<GtoTreeId, Promise<PfData>>();

export function loadGtoTree(id: GtoTreeId, signal?: AbortSignal): Promise<PfData> {
  let p = treeCache.get(id);
  if (!p) {
    p = fetchSolutionWithRetry<PfData>(
      PF_SOLUTION_URLS[id],
      signal ?? new AbortController().signal,
    );
    p.catch(() => treeCache.delete(id));
    treeCache.set(id, p);
  }
  return p;
}

/* ---- 提取工具 ---- */

/** 手牌标签（meta.order，如 "AKs"/"QQ"/"T9o"）→ 13×13 网格坐标。约定同 rangeMatrix：右上 suited、左下 offsuit。 */
function labelToCell(label: string): [number, number] | null {
  const a = RANKS.indexOf(label[0]);
  const b = RANKS.indexOf(label[1]);
  if (a < 0 || b < 0) return null;
  if (label.length === 2) return a === b ? [a, a] : null;
  if (label[2] === "s") return [Math.min(a, b), Math.max(a, b)];
  return [Math.max(a, b), Math.min(a, b)];
}

/** 加注类动作（含 All-in；不含 Fold/Call/Check） */
function isRaiseName(n: string): boolean {
  return n !== "Fold" && n !== "Call" && n !== "Check";
}

/** meta.order[169] → 每手牌的网格坐标（无法归类的手牌置 null，跳过涂格） */
function orderCells(data: PfData): ([number, number] | null)[] {
  return data.meta.order.map(labelToCell);
}

/**
 * ① RFI 开池范围：位置 i 的决策节点 key = "Fold"×i。
 * 每格频率 = 该节点全部加注动作频率之和（多开注尺寸时自然合并为「总开池率」）。
 */
export function treeToRfiGrids(data: PfData): Record<string, FreqGrid> {
  const cells = orderCells(data);
  const out: Record<string, FreqGrid> = {};
  GTO_RFI_SLOTS.forEach((slot, i) => {
    const key = Array(i).fill("Fold").join("/");
    const node = data.nodes[key];
    const grid = emptyGrid();
    if (node?.a) {
      const raiseQ = node.a.filter(([n]) => isRaiseName(n)).map(([, q]) => q);
      for (let h = 0; h < 169 && h < cells.length; h++) {
        const cell = cells[h];
        if (!cell) continue;
        let f = 0;
        for (const q of raiseQ) f = Math.min(1, f + freqAt(q, h));
        grid[cell[0]][cell[1]] = f;
      }
    }
    out[slot] = grid;
  });
  return out;
}

export type BbDefendGridPair = { grid3bet: FreqGrid; gridCall: FreqGrid };
export type BbDefendExtract = {
  /** 每个对手位置的 BB 防守（3bet / call 两张矩阵） */
  grids: Record<string, BbDefendGridPair>;
  /** 该树各位置的开注尺寸（bb，从动作名解析；混合尺寸时取频率最大的一个），供 UI 标注 */
  openSize: Record<string, number | null>;
};

/**
 * ② BB 面对开池的防守。
 * 位置 i open 动作 o 后，其余 4-i 个位置全弃到 BB：
 *   key = "Fold"×i + "/" + o + "/Fold"×(4-i)
 * RFI 节点若存在多个 open 尺寸（未来混合解），按各 open 的逐手频率加权合并防守矩阵；
 * 当前三套树均为单尺寸，加权退化为直接取值。
 */
export function treeToBbDefendGrids(data: PfData): BbDefendExtract {
  const cells = orderCells(data);
  const grids: Record<string, BbDefendGridPair> = {};
  const openSize: Record<string, number | null> = {};

  GTO_RFI_SLOTS.forEach((slot, i) => {
    const rfiKey = Array(i).fill("Fold").join("/");
    const rfi = data.nodes[rfiKey];
    const grid3bet = emptyGrid();
    const gridCall = emptyGrid();
    openSize[slot] = null;

    if (rfi?.a) {
      // open 候选 = 非弃牌非跟注动作（Raise N bb / All-in）
      const opens = rfi.a.filter(([n]) => isRaiseName(n));
      // 开注尺寸标注：取第一档（多档时取名字里的数值，All-in 无值）
      for (const [n] of opens) {
        const m = n.match(/^Raise ([\d.]+) bb$/);
        if (m) {
          openSize[slot] = parseFloat(m[1]);
          break;
        }
      }
      for (let h = 0; h < 169 && h < cells.length; h++) {
        const cell = cells[h];
        if (!cell) continue;
        let f3 = 0;
        let fc = 0;
        for (const [openName, openQ] of opens) {
          const openFreq = freqAt(openQ, h); // 该手用此 open 尺寸的频率（单尺寸=1）
          if (openFreq <= 0) continue;
          const bbKey =
            (rfiKey ? rfiKey + "/" : "") + openName +
            Array(4 - i).fill("/Fold").join("");
          const bbNode: PfNode | undefined = data.nodes[bbKey];
          if (!bbNode?.a) continue;
          for (const [actName, q] of bbNode.a) {
            const v = freqAt(q, h) * openFreq;
            if (isRaiseName(actName)) f3 = Math.min(1, f3 + v);
            else if (actName === "Call") fc = Math.min(1, fc + v);
          }
        }
        grid3bet[cell[0]][cell[1]] = f3;
        gridCall[cell[0]][cell[1]] = fc;
      }
    }
    grids[slot] = { grid3bet, gridCall };
  });

  return { grids, openSize };
}
