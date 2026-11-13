"use client";

/* ----------------------------------------------------------------
   一键分享：把数据总览（四行卡片 + 完整盈利曲线）重绘到离屏 canvas，
   曲线左上角盖「ID + 分享时间」印章，PNG 自动复制到剪贴板
   （剪贴板被拦截时降级为下载图片）。印章提供四种样式，弹窗内实时预览选择。
   卡片与曲线的数据全部由 page.tsx 计算好传入，这里只负责绘制。
   ---------------------------------------------------------------- */
import { useEffect, useMemo, useRef, useState } from "react";

export type ShareSealStyle = "rect" | "square" | "circle" | "ellipse";

export type ShareStatItem = {
  label: string;
  value: string;
  color?: string;
  emphasis?: "primary" | "rake" | "metric";
  gto?: string; // 第三行频率卡基准（带 %）
};

export type SharePosCard = {
  pos: string;
  val: string; // "+12.34" 或 "—"
  color: string;
  gto: number;
  pro: number;
};

const SEAL_STYLES: { id: ShareSealStyle; name: string }[] = [
  { id: "rect", name: "圆角双线" },
  { id: "square", name: "方形篆刻" },
  { id: "circle", name: "圆形双圈" },
  { id: "ellipse", name: "椭圆双圈" },
];

const SEAL_RED = "#cf3a2b";
const FONT = `"system-ui", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`;

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- 印章 ----------------
   以 (cx, cy) 为中心绘制，整体旋转 -8°，半透明印泥红。
   id 自动缩放字号适配章宽。 */
export function drawSeal(
  ctx: CanvasRenderingContext2D,
  style: ShareSealStyle,
  id: string,
  time: string,
  cx: number,
  cy: number,
  scale = 1,
) {
  const maxTextW = 220 * scale;
  let fs = 30 * scale;
  ctx.save();
  ctx.font = `700 ${fs}px ${FONT}`;
  while (ctx.measureText(id).width > maxTextW && fs > 12) {
    fs -= 1;
    ctx.font = `700 ${fs}px ${FONT}`;
  }
  const textW = ctx.measureText(id).width;
  const timeFs = Math.max(11, Math.round(fs * 0.48));
  const timeW = (ctx.font = `${timeFs}px ${FONT}`, ctx.measureText(time).width);

  ctx.globalAlpha = 0.88;
  ctx.strokeStyle = SEAL_RED;
  ctx.fillStyle = SEAL_RED;
  ctx.translate(cx, cy);
  ctx.rotate((-8 * Math.PI) / 180);

  const drawTexts = (dy: number) => {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fs}px ${FONT}`;
    ctx.fillText(id, 0, dy);
    ctx.font = `${timeFs}px ${FONT}`;
    ctx.fillText(time, 0, dy + fs * 0.85);
  };

  if (style === "rect" || style === "square") {
    const w = Math.max(textW, timeW) + 34 * scale;
    const h = fs * 0.85 + fs + 30 * scale;
    const r = style === "rect" ? 8 * scale : 2;
    ctx.lineWidth = 3 * scale;
    rr(ctx, -w / 2, -h / 2, w, h, r);
    ctx.stroke();
    ctx.lineWidth = 1.1;
    rr(ctx, -w / 2 + 5 * scale, -h / 2 + 5 * scale, w - 10 * scale, h - 10 * scale, Math.max(0, r - 3));
    ctx.stroke();
    drawTexts(-fs * 0.32);
  } else if (style === "circle") {
    const r = Math.max(textW, timeW) / 2 + 26 * scale;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, r - 6 * scale, 0, Math.PI * 2);
    ctx.stroke();
    drawTexts(-fs * 0.36);
  } else {
    const rx = Math.max(textW, timeW) / 2 + 24 * scale;
    const ry = fs * 1.35;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 5 * scale, ry - 5 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
    drawTexts(-fs * 0.36);
  }
  ctx.restore();
}

/* ---------------- 分享图生成 ---------------- */
export function generateShareImage(opts: {
  rows: ShareStatItem[][];
  posCards: SharePosCard[];
  chartCanvas: HTMLCanvasElement | null;
  sealStyle: ShareSealStyle;
  id: string;
  time: string;
  chartOnly?: boolean; // true = 只曲线不卡片
}): HTMLCanvasElement {
  const { rows, posCards, chartCanvas, sealStyle, id, time, chartOnly } = opts;
  const W = 1240, M = 40, GAP = 12;
  const inner = W - M * 2; // 1160
  const cardW = Math.floor((inner - GAP * 7) / 8); // 134
  const cardH = 118;
  const HDR = 64; // 图版头（品牌行 + 金线），chartOnly 也保留——传播出去必须带署名
  const FTR = 52; // 页脚水印行
  const chartAspect = chartCanvas && chartCanvas.height ? chartCanvas.height / chartCanvas.width : 300 / 1050;
  const chartW = inner;
  const chartH = Math.round(chartW * chartAspect);
  const y0 = M + HDR;
  const chartY = chartOnly ? y0 : y0 + 4 * cardH + 3 * GAP + 16;
  const H = chartY + chartH + FTR;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // 背景
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  // 图版头：金色站名 + 灰副标，下发丝金线
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  try { (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "5px"; } catch { /* 旧浏览器忽略 */ }
  ctx.font = `700 19px ${FONT}`;
  ctx.fillStyle = "#a88b46";
  ctx.fillText("BANSOLVER", M, M + 22);
  try { (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px"; } catch { /* noop */ }
  ctx.textAlign = "right";
  ctx.font = `500 14px ${FONT}`;
  ctx.fillStyle = "#71717a";
  ctx.fillText("千算Poker · BAN2NOTE", W - M, M + 22);
  ctx.strokeStyle = "rgba(168,139,70,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M, M + 44);
  ctx.lineTo(W - M, M + 44);
  ctx.stroke();

  const valColor = (it: ShareStatItem) =>
    it.color ?? (it.emphasis === "rake" ? "#f59e0b" : it.emphasis === "metric" ? "#d4d4d8" : "#e4e4e7");

  const drawCard = (x: number, y: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
    ctx.fillStyle = "#141417";
    rr(ctx, x, y, cardW, cardH, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.stroke();
    draw(ctx);
  };

  const centerText = (text: string, cx: number, y: number, font: string, color: string) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, y);
  };

  // 前三行统计卡 + 第四行位置卡（chartOnly 时全部跳过）
  if (!chartOnly) {
    rows.forEach((row, ri) => {
      row.forEach((it, ci) => {
        const x = M + ci * (cardW + GAP);
        const y = y0 + ri * (cardH + GAP);
        drawCard(x, y, () => {
          if (!it.value) return;
          centerText(it.label, x + cardW / 2, y + 26, `600 15px ${FONT}`, "#9ca3af");
          centerText(it.value, x + cardW / 2, y + 58, `700 27px ${FONT}`, valColor(it));
          if (it.gto) centerText(`GTO ${it.gto}`, x + cardW / 2, y + 92, `400 13px ${FONT}`, "#71717a");
        });
      });
    });

    // 位置行顺序由 page 侧 posCards（POS_MAIN_ORDER）决定，不在本文件手抄第二份——
    // 口径/顺序改动只需改 page 一处（此前手抄曾随位置口径三连改漂移）
    const posRowY = y0 + 3 * (cardH + GAP);
    posCards.forEach((c, ci) => {
      const x = M + ci * (cardW + GAP);
      drawCard(x, posRowY, () => {
        const cx = x + cardW / 2;
        centerText(c.pos, cx, posRowY + 24, `600 15px ${FONT}`, "#d4d4d8");
        centerText(c.val, cx, posRowY + 56, `700 26px ${FONT}`, c.color);
        ctx.textBaseline = "middle";
        ctx.font = `400 13px ${FONT}`;
        ctx.fillStyle = "#71717a";
        ctx.textAlign = "right";
        ctx.fillText("GTO", cx - 16, posRowY + 84);
        ctx.fillText("PRO", cx - 16, posRowY + 100);
        ctx.textAlign = "left";
        ctx.fillStyle = "#a88b46";
        ctx.fillText(String(c.gto), cx - 10, posRowY + 84);
        ctx.fillStyle = "#b8b8c0";
        ctx.fillText(String(c.pro), cx - 10, posRowY + 100);
      });
    });
  }

  // 曲线
  if (chartCanvas) {
    ctx.drawImage(chartCanvas, M, chartY, chartW, chartH);
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.strokeRect(M, chartY, chartW, chartH);
  }

  // 印章：曲线左上角
  drawSeal(ctx, sealStyle, id, time, M + 130, chartY + 76, 1);

  // 页脚水印：传播落点
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `500 14px ${FONT}`;
  ctx.fillStyle = "#71717a";
  ctx.fillText("bansolver.com · 千算Poker 免费工具站", W / 2, chartY + chartH + FTR / 2);

  return canvas;
}

/* ---------------- 弹窗 ---------------- */
export default function ShareModal({
  open,
  onClose,
  rows,
  posCards,
  chartCanvas,
  defaultId,
}: {
  open: boolean;
  onClose: () => void;
  rows: ShareStatItem[][];
  posCards: SharePosCard[];
  chartCanvas: HTMLCanvasElement | null;
  defaultId: string;
}) {
  const [id, setId] = useState(defaultId);
  // 用户 2026-09-22 选定第 4 种「椭圆双圈」为默认章型
  const [seal, setSeal] = useState<ShareSealStyle>("ellipse");
  // 只分享曲线（不含卡片），默认关闭
  const [chartOnly, setChartOnly] = useState(false);
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState("");
  const previewsRef = useRef<HTMLDivElement>(null);

  const time = useMemo(
    () =>
      new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).replace(/\//g, "-"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  // 四种印章小样
  useEffect(() => {
    if (!open || !previewsRef.current) return;
    previewsRef.current.querySelectorAll("canvas").forEach((c) => {
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#101014";
      ctx.fillRect(0, 0, c.width, c.height);
      drawSeal(ctx, c.dataset.style as ShareSealStyle, id || "千算", time, c.width / 2, c.height / 2, 0.72);
    });
  }, [open, id, time, seal]);

  if (!open) return null;

  const generate = async () => {
    if (!id.trim()) { setStatus("请先输入你的 ID"); return; }
    const canvas = generateShareImage({ rows, posCards, chartCanvas, sealStyle: seal, id: id.trim(), time, chartOnly });
    setPreview(canvas.toDataURL("image/png"));
    try {
      const blobP = new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      const item = new ClipboardItem({ "image/png": blobP as Promise<Blob> });
      await navigator.clipboard.write([item]);
      setStatus("✓ 已复制到剪贴板，去微信/QQ 直接粘贴");
    } catch {
      // 不落本地文件：只提示（预览图也可右键手动另存）
      setStatus("剪贴板被浏览器拦截，请右键预览图另存或换 Chrome/Edge 打开本站");
    }
  };

  return (
    <div className="b2rp-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="b2rp-panel ban2-share-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="一键分享">
        <div className="b2rp-head">
          <span className="b2rp-title">一键分享</span>
          <button type="button" className="ban2-share-generate" onClick={generate}>生成并复制</button>
          <button type="button" className="ban2-share-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="ban2-share-body">
          <label className="ban2-share-label">
            你的 ID（刻在章上）
            <input
              className="ban2-share-input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="牌手名 / 昵称"
            />
          </label>
          <label className="ban2-share-check">
            <input type="checkbox" checked={chartOnly} onChange={(e) => setChartOnly(e.target.checked)} />
            只分享曲线（不含统计卡片）
          </label>
          <div className="ban2-share-styles" ref={previewsRef}>
            {SEAL_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`ban2-share-style${seal === s.id ? " ban2-share-style--on" : ""}`}
                onClick={() => setSeal(s.id)}
              >
                <canvas data-style={s.id} width={120} height={72} />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
          {preview && <img className="ban2-share-preview" src={preview} alt="分享图预览" />}
          {status && <p className="ban2-share-status" role="status">{status}</p>}
        </div>
      </div>
    </div>
  );
}
