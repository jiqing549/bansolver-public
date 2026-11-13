export interface SimResult {
  totalBb: number;
  downswing: number;
}

export interface VarianceSimStats {
  mean: number;
  std: number;
  ci95Low: number;
  ci95High: number;
  lossProb: number;
  worstDown: number;
  meanDown: number;
  downswings: number[];
}

function normalRandom(mean: number, std: number): number {
  let u1 = Math.random();
  const u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

export function simulate(
  winRate: number,
  stdDev: number,
  hands: number,
  runs: number,
): { results: SimResult[]; stats: VarianceSimStats } {
  // P2-2: support a partial final block. Full blocks are 100-hand; a leftover
  // (<100 hands) is modeled with stdDev scaled by sqrt(partial/100) so its variance
  // contribution matches the actual remaining hand count, and expectation stays linear.
  const blocks = Math.floor(hands / 100);
  const partial = hands % 100;
  const partialStd = partial > 0 ? stdDev * Math.sqrt(partial / 100) : 0;
  const results: SimResult[] = [];

  for (let r = 0; r < runs; r++) {
    let cum = 0;
    let peak = 0;
    let maxDown = 0;
    for (let i = 0; i < blocks; i++) {
      cum += normalRandom(winRate, stdDev);
      if (cum > peak) peak = cum;
      const drawdown = peak - cum;
      if (drawdown > maxDown) maxDown = drawdown;
    }
    if (partial > 0) {
      // A partial block has expectation proportional to its hand fraction.
      cum += normalRandom(winRate * (partial / 100), partialStd);
      if (cum > peak) peak = cum;
      const drawdown = peak - cum;
      if (drawdown > maxDown) maxDown = drawdown;
    }
    results.push({ totalBb: cum, downswing: maxDown });
  }

  const n = results.length;
  const sorted = [...results].sort((a, b) => a.totalBb - b.totalBb);
  const downSorted = [...results].sort((a, b) => b.downswing - a.downswing);
  const downswings = downSorted.map((r) => r.downswing).sort((a, b) => a - b);

  const mean = results.reduce((s, r) => s + r.totalBb, 0) / n;
  const variance = results.reduce((s, r) => s + (r.totalBb - mean) ** 2, 0) / n;

  return {
    results,
    stats: {
      mean,
      std: Math.sqrt(variance),
      ci95Low: sorted[Math.floor(n * 0.025)].totalBb,
      ci95High: sorted[Math.floor(n * 0.975)].totalBb,
      lossProb: results.filter((r) => r.totalBb < 0).length / n,
      worstDown: downSorted[0].downswing,
      meanDown: results.reduce((s, r) => s + r.downswing, 0) / n,
      downswings,
    },
  };
}

export function deriveFromSession(
  totalHands: number,
  netProfitBB: number,
  netHistory: { profit: number }[],
) {
  const winRate = totalHands > 0 ? (netProfitBB / totalHands) * 100 : 0;

  const perHand: number[] = [];
  for (let i = 0; i < netHistory.length; i++) {
    const prev = i > 0 ? netHistory[i - 1].profit : 0;
    perHand.push(netHistory[i].profit - prev);
  }

  let stdDev = 100;
  if (perHand.length >= 2) {
    const mean = perHand.reduce((a, b) => a + b, 0) / perHand.length;
    const variance = perHand.reduce((s, x) => s + (x - mean) ** 2, 0) / perHand.length;
    stdDev = Math.sqrt(variance) * 10;
  }

  let peak = 0;
  let maxDrawdown = 0;
  for (const d of netHistory) {
    if (d.profit > peak) peak = d.profit;
    maxDrawdown = Math.max(maxDrawdown, peak - d.profit);
  }

  return {
    winRate: Math.round(winRate * 100) / 100,
    stdDev: Math.round(stdDev * 10) / 10,
    hands: totalHands,
    maxDrawdown: Math.round(maxDrawdown * 10) / 10,
  };
}

/**
 * 回撤百分位：玩家的实际最大回撤在模拟分布中「排第几」。
 * 返回 0~1：0.95 = 比这个回撤更小的模拟只占 5%（玩家相当倒霉），
 *           0.20 = 80% 的模拟回撤更大（玩家运气正常或偏好）。
 */
export function drawdownPercentile(actualDown: number, simulatedDownswings: number[]) {
  if (simulatedDownswings.length === 0) return 0;
  const worse = simulatedDownswings.filter((d) => d < actualDown).length;
  return worse / simulatedDownswings.length;
}

export function sortResultsByProfit(results: SimResult[]): SimResult[] {
  return [...results].sort((a, b) => a.totalBb - b.totalBb);
}

/**
 * 百手赢率（bb/100）的 95% 置信区间。
 * 公式：mean ± 1.96 × stdDev / sqrt(N)，N = 百手块数 = hands/100。
 * 用于告诉玩家"基于这段样本，你的真实水平大概落在哪个 bb/100 范围"。
 * 样本越小（hands 越小）区间越宽；hands < 100 时返回 null（不足一个百手块）。
 * 口径：与 deriveFromSession 一致，均为水后（netProfitBB）。
 */
export function winRateConfidenceInterval(
  winRate: number,
  stdDev: number,
  hands: number,
): { low: number; high: number } | null {
  const blocks = hands / 100;
  if (blocks < 1) return null;
  const margin = 1.96 * (stdDev / Math.sqrt(blocks));
  return { low: winRate - margin, high: winRate + margin };
}

/** 收益分布直方图（与 Ban2Note 波动预估同款） */
export function drawVarianceHistogram(
  canvas: HTMLCanvasElement,
  sorted: SimResult[],
  options?: { compact?: boolean },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx || sorted.length === 0) return;

  const compact = options?.compact ?? false;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W <= 0 || H <= 0) return;

  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const n = sorted.length;
  const minVal = sorted[0].totalBb;
  const maxVal = sorted[n - 1].totalBb;
  const range = maxVal - minVal || 1;
  const bins = compact ? 40 : 60;
  const binW = range / bins;
  const histogram = new Array(bins).fill(0);
  for (const r of sorted) {
    const idx = Math.min(Math.floor((r.totalBb - minVal) / binW), bins - 1);
    histogram[idx]++;
  }
  const maxCount = Math.max(...histogram);

  const pad = compact
    ? { top: 8, right: 8, bottom: 22, left: 32 }
    : { top: 20, right: 20, bottom: 40, left: 50 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  const gridLines = compact ? 3 : 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (plotH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
  }

  const barW = plotW / bins;
  for (let i = 0; i < bins; i++) {
    const barH = (histogram[i] / maxCount) * plotH;
    const x = pad.left + i * barW;
    const y = pad.top + plotH - barH;
    const binCenter = minVal + (i + 0.5) * binW;
    ctx.fillStyle = binCenter < 0 ? "rgba(239,68,68,0.35)" : "rgba(168,139,70,0.4)";
    ctx.fillRect(x + 1, y, barW - 2, barH);
  }

  if (minVal < 0 && maxVal > 0) {
    const zeroX = pad.left + ((0 - minVal) / range) * plotW;
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(zeroX, pad.top);
    ctx.lineTo(zeroX, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(W - pad.right, pad.top + plotH);
  ctx.stroke();

  ctx.fillStyle = "#71717a";
  ctx.font = compact ? "10px ui-monospace, monospace" : "11px ui-monospace, monospace";
  ctx.textAlign = "center";
  const xLabels = compact ? 3 : 4;
  for (let i = 0; i <= xLabels; i++) {
    const val = minVal + (range / xLabels) * i;
    const x = pad.left + (plotW / xLabels) * i;
    ctx.fillText(`${Math.round(val)}`, x, pad.top + plotH + (compact ? 14 : 18));
  }
  if (!compact) ctx.fillText("bb", W - pad.right, pad.top + plotH + 18);

  if (!compact) {
    ctx.textAlign = "right";
    ctx.fillText("0", pad.left - 8, pad.top + plotH);
    ctx.fillText(`${maxCount}`, pad.left - 8, pad.top + 8);
  }
}
