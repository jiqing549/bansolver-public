/* ================================================================
   hhEv —— All-in EV 求解（客户端本地执行）
   拍板口径：EV 枚举不出客户端，解析上云只搬 parse 阶段。本文件与
   equity.ts（N 路枚举器）都属于前端可见代码；解析器实现在
   handHistory.ts（服务端专属，前端禁止 import）。
   ================================================================ */

import { computeAllInEquityNway } from "./equity";

// ── EV 两阶段：plan 收集（快）与枚举求解（慢）分离 ─────────────
//
// 翻前全下的 N 路精确枚举占整包解析 85-92% 耗时（guazi 47,376 手实测 169 个
// 独立 matchup 结构 ~58s）。两阶段让页面先渲染基础数据与非 EV 曲线，EV 在
// Worker 后台逐批补算：parseSingleHand 以 evOut 收集 EvPlan（纯数据快照，
// allInEV 留 null），solveEvPlan 之后再逐个求解。不传 evOut 则保持旧语义
// （解析时就地计算，结果完全一致）。
export type EvPlan = {
  handId: string;
  heroHole: number[];
  bb: number;
  heroInvested: number;
  boards: number[][];      // 跑两次/三次 = 多条牌面，EV 取平均；翻前为空数组们
  oppHoles: number[][];    // 分层参与者对手底牌（与 partInv[1..] 对齐）
  partInv: number[];       // participants 全体投入，Hero 居首位（Hero 已含 ante）
  deadInv: number[];       // 非参与玩家各自的整池投入（invested+ante 合并口径）
};

/**
 * 求解一个 EvPlan，返回 allInEV（BB，两位小数）。枚举异常时返回 null
 * （与旧的就地计算 catch 兜底语义一致）。
 */
export function solveEvPlan(plan: EvPlan): number | null {
  try {
    // 分层边池：参与者投入升序切层；第 k 层 = Σ min(inv,t) − Σ min(inv,prev) + 死钱层，
    // 参与者 = 投入 ≥ t 者；Hero 只参与到自身投入封顶的层（多人全下时单对手公式会低估）。
    const thresholds = [...new Set(plan.partInv)].sort((a, b) => a - b);
    let prevT = 0;
    let evUSD = 0;
    for (const t of thresholds) {
      if (t <= 1e-9) continue;
      if (t > plan.heroInvested + 1e-6) break; // 更深的层 Hero 没跟得动（uncalled 已退款，防御性）
      const layerOpps: number[][] = [];
      for (let i = 0; i < plan.oppHoles.length; i++) {
        if (plan.partInv[i + 1] >= t - 1e-6) layerOpps.push(plan.oppHoles[i]);
      }
      if (layerOpps.length === 0) {
        prevT = t;
        continue;
      }
      let size = 0;
      for (const v of plan.partInv) size += Math.min(v, t) - Math.min(v, prevT);
      for (const v of plan.deadInv) size += Math.max(0, Math.min(v, t) - Math.min(v, prevT));
      let equitySum = 0;
      for (const b of plan.boards) {
        equitySum += computeAllInEquityNway(plan.heroHole, layerOpps, b);
      }
      evUSD += (equitySum / plan.boards.length) * size;
      prevT = t;
    }
    evUSD -= plan.heroInvested;
    return Math.round((evUSD / plan.bb) * 100) / 100;
  } catch {
    return null;
  }
}
