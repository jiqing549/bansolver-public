// ban2note 解析 Worker：两阶段渐进解析（本地）。
//   阶段一：接收多个文本排队处理，逐文本分批（每批 1000 个原始手块）快速解析，
//           EV 只收集计划不求解；每个文本解析完立即 postMessage hands——主线程
//           马上渲染基础数据与非 EV 曲线（翻前全下枚举占整包 85-92% 耗时，
//           跳过它才能秒级出数）。
//   阶段二：主线程发 finish（文本发完）且队列清空后，逐批 solveEvPlan 补算 EV，
//           每批回报一次，主线程渐进点亮 EV 线。
// 数字口径与整包 parseGGHandHistory 完全一致（stats 由页面统一计算）；
// 批内去重由 parseHandsChunk 做，跨批/跨文本去重在本文按 id 合并。
// 2026-10-27 回退记录：解析上云（/api/parse）因 Cloudflare isolate 内存跨请求
// 累积不可控（大文件用户打饱和后全员「服务器繁忙」）整体撤回，解析回本地。
import { parseHandsChunk } from "@/lib/handHistory";
import { solveEvPlan, type EvPlan } from "@/lib/hhEv";
import type { ParsedHand } from "@/lib/hhTypes";

export type ParseWorkerProgress = {
  type: "progress";
  totalChunks: number;
  scannedChunks: number;
  keptHands: number;
};
// 单个文本阶段一完成：基础数据可渲染；evTotal>0 表示该文本还有 EV 待补算
export type ParseWorkerHands = {
  type: "hands";
  hands: ParsedHand[];
  duplicateHands: number;
  evTotal: number;
};
// 阶段二增量：一批 EV 已算好（id → allInEV，null = 该手枚举失败维持 fallback）
export type ParseWorkerEvBatch = {
  type: "ev";
  results: { id: string; allInEV: number | null }[];
  solved: number;
  total: number;
};
export type ParseWorkerEvDone = { type: "evDone" };
export type ParseWorkerError = { type: "error"; message: string };

const BATCH_CHUNKS = 1000;
// EV 批大小：单个翻前 plan 首算 ~100-350ms，4 个一批 ≈ 每隔 1-2s 推一次增量，
// 主线程每次合并只需重算一次 stats（47k 手 ~50ms），节奏与成本平衡
const EV_BATCH = 4;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (
    msg: ParseWorkerProgress | ParseWorkerHands | ParseWorkerEvBatch | ParseWorkerEvDone | ParseWorkerError,
  ) => void;
};

// 让出事件循环必须用 MessageChannel 宏任务：setTimeout 在页面隐藏/后台时会被
// Chrome 密集节流（实测钳到分钟级，进度假死），MessageChannel 不受节流影响
const yieldToLoop = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });

const textQueue: string[] = [];
// 跨文本去重与 EV 计划表必须放模块级：drain 可能在 finish 到达前进出多次
// （队列暂时为空），局部表会丢掉之前文本的手牌，跨文本重复去重失效
const byId = new Map<string, ParsedHand>();
const evById = new Map<string, EvPlan>();
let sealed = false; // 主线程已发 finish：不再有新文本
let draining = false;

async function parseOne(text: string): Promise<void> {
  // 原始文本切手块：覆盖 GG（Poker Hand # / PokerStars Zoom Hand #）与
  // CoinPoker（CoinPoker Hand #）头行。切得比 parseHandsChunk 内部更早只是
  // 为了让进度可回报；批边界都落在真实头行上，解析结果与整包一致
  // （CoinPoker 转译由 parseHandsChunk 入口自动完成）。
  const chunks = text.split(/[\r\n]+(?=(?:Poker(?:Stars Zoom)?|CoinPoker) Hand #)/);
  let duplicateHands = 0;
  // 只上报本文本「新进」byId 的手牌：历史上这里发的是全量累计表，主线程把
  // 重发的旧手全计成「已去重」，多文件上传时去重计数严重虚增（2026-11-03 审查 P1）。
  // 跨文本重复在下方 byId.has 处计入本文本的 duplicateHands，语义不变。
  const fresh: ParsedHand[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_CHUNKS) {
    const evOut = { plans: [] as EvPlan[] };
    const batch = chunks.slice(i, i + BATCH_CHUNKS).join("\n");
    const { hands, duplicateHands: dups } = parseHandsChunk(batch, "Hero", evOut);
    duplicateHands += dups;
    for (const h of hands) {
      if (byId.has(h.id)) duplicateHands++;
      else {
        byId.set(h.id, h);
        fresh.push(h);
      }
    }
    for (const p of evOut.plans) evById.set(p.handId, p);
    ctx.postMessage({
      type: "progress",
      totalChunks: chunks.length,
      scannedChunks: Math.min(i + BATCH_CHUNKS, chunks.length),
      keptHands: byId.size,
    });
    await yieldToLoop();
  }
  ctx.postMessage({
    type: "hands",
    hands: fresh,
    duplicateHands,
    evTotal: evById.size,
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // ── 阶段一：本地快速解析（EV 只收集 plan），逐文本回报 hands ──
    while (textQueue.length > 0) {
      await parseOne(textQueue.shift()!);
      await yieldToLoop();
    }
    // ── 阶段二：文本发完后逐批补算 EV ──
    if (sealed) {
      const plans = [...evById.values()];
      evById.clear();
      let solved = 0;
      for (let i = 0; i < plans.length; i += EV_BATCH) {
        const results: { id: string; allInEV: number | null }[] = [];
        for (const p of plans.slice(i, i + EV_BATCH)) {
          results.push({ id: p.handId, allInEV: solveEvPlan(p) });
          solved++;
        }
        ctx.postMessage({ type: "ev", results, solved, total: plans.length });
        await yieldToLoop();
      }
      ctx.postMessage({ type: "evDone" });
    }
  } catch (err: unknown) {
    // 不传播的话主线程会永久等待；void 掉的 async 调用会吞错
    textQueue.length = 0;
    ctx.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    draining = false;
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const d = e.data as { type: string; text?: string };
  if (d.type === "parse" && typeof d.text === "string") {
    textQueue.push(d.text);
  } else if (d.type === "finish") {
    sealed = true;
  }
  void drain();
};
