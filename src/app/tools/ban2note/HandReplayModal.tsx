"use client";

/* ================================================================
   单手回放弹窗
   ================================================================
   上：牌桌俯视图（椭圆绿呢 + 环形座位 + 中央公共牌 / 底池）
   中：播放条（回到开头 / 播放暂停 / 单步 + 步数与当前街）
   下：逐街行动路线（盲注列 + 翻牌前 / 翻牌 / 转牌 / 河牌各一列，
       列头带街初底池，全下摊牌后无行动的街画本街新发的牌）

   数据来自 parseHandForReplay(raw)（见 handReplay.ts）；
   点击遮罩 / ✕ / Esc 关闭；传入 onPrev/onNext 时舞台两侧出现
   ‹ › 翻手按钮（首/尾手禁用），← → 方向键同效，标题栏显示序号。

   播放：直接从翻牌前第一个动作开始（盲注不逐步，底池/投入初始值已计入盲注），
   按时间线（各街标记=发牌 → 该街动作）逐动作推进；播放中路线区只显示
   当前步高亮（点任意动作可跳到那一步），公共牌到本街标记才翻开，
   对手底牌与 WIN 徽章到收池（或播完）才亮；Space 播放/暂停，← → 仍是切手。
   ================================================================ */

import { useEffect, useState } from "react";
import {
  amountToBB,
  numOr0,
  parseHandForReplay,
  type ReplayAct,
  type ReplayHand,
} from "./handReplay";

const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** 回放行：与逐手明细行 / 逐手牌谱表行共用的最小字段集 */
export interface ReplayRowData {
  raw: string;
  time: string; // 已格式化的时间戳短串（stampDate 输出）
  stakes: string;
  pot: number; // 全场收池合计（$）
  cards: string; // Hero 底牌，如 "As Kd"
  heroWon?: boolean; // Hero 是否赢下底池（逐手明细行有，逐手牌谱行可省）
}

/** 翻页导航（可选）：调用方按自己的列表顺序传入 上一手/下一手 回调与端点状态 */
export interface ReplayNavProps {
  posLabel?: string; // 形如「12 / 2576」，显示在标题栏
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}

/** 一张牌：白底 + 四色花色（黑桃灰 / 红桃红 / 梅花绿 / 方块蓝） */
function Card({ card, size }: { card: string; size?: "sm" | "lg" }) {
  const suit = card.length >= 2 ? card.charAt(card.length - 1).toLowerCase() : "";
  const rank = card.length >= 2 ? card.slice(0, -1) : card;
  const color =
    suit === "h" ? " b2rp-card--red" :
    suit === "c" ? " b2rp-card--green" :
    suit === "d" ? " b2rp-card--blue" : "";
  return (
    <span className={`b2rp-card${color}${size ? ` b2rp-card--${size}` : ""}`}>
      <b className="b2rp-r">{rank}</b>
      <b className="b2rp-s">{SUITS[suit] || ""}</b>
    </span>
  );
}

function Cards({ text, size }: { text: string; size?: "sm" | "lg" }) {
  const cards = (text || "").trim().split(/\s+/).filter(Boolean);
  return (
    <>
      {cards.map((c, i) => <Card key={`${c}-${i}`} card={c} size={size} />)}
    </>
  );
}

/** 行动一枚：位置徽标 + 玩家名 + 「行动名 + 金额」胶囊；播放中点已出现的动作可跳到该步 */
function ActChip({ act, bb, now, seekable, onSeek }: {
  act: ReplayAct;
  bb: number;
  now: boolean;
  seekable: boolean;
  onSeek?: () => void;
}) {
  const badge = act.pos || (act.seat !== "" ? `#${act.seat}` : "—");
  const txt = act.name + (act.amt > 0 ? ` ${amountToBB(act.amt, bb)} BB` : "");
  const win = act.kind === "collect";
  const drop = act.name === "红包"; // 红包桌庄家注入（非玩家行动，盲注列合成的胶囊）
  return (
    <div className={"b2rp-cell" + (now ? " b2rp-cell--now" : "")}>
      <div className="b2rp-cell-top">
        <span className={`b2rp-pos${act.kind === "post" && !drop ? " b2rp-pos--blind" : ""}${drop ? " b2rp-pos--redpacket" : ""}`}>{badge}</span>
        <span className="b2rp-pname">{act.isHero ? "Hero" : act.actor}</span>
      </div>
      <span
        className={
          "b2rp-chip" +
          (act.isHero ? " b2rp-chip--hero" : "") +
          (act.kind === "fold" ? " b2rp-chip--fold" : "") +
          (act.kind === "post" && !drop ? " b2rp-chip--blind" : "") +
          (drop ? " b2rp-chip--redpacket" : "") +
          (win ? " b2rp-chip--win" : "") +
          (now ? " b2rp-chip--now" : "") +
          (seekable ? " b2rp-chip--seek" : "")
        }
        title={seekable ? "点击跳到这一步" : undefined}
        onClick={seekable && onSeek ? onSeek : undefined}
      >
        {txt}
      </span>
    </div>
  );
}

interface RouteCol {
  key: string;
  label: string;
  pot: number;
  acts: ReplayAct[];
  boardNew: string;
  board2New: string;
  board3New: string;
}

/** 路线列：盲注列收全部 post；各街列放非 post 行动（与旧行为一致）。
    红包桌在盲注列最前加一枚红包胶囊——庄家注入的钱不是行动，但列在这里
    才能解释「翻牌前列头底池为什么比盲注合计多一截」 */
function buildCols(parsed: ReplayHand): RouteCol[] {
  const posts: ReplayAct[] = [];
  if (parsed.cashDrop > 0) {
    posts.push({
      actor: "红包", pos: "🧧", seat: "", isHero: false,
      kind: "post", amt: parsed.cashDrop, name: "红包",
    });
  }
  for (const st of parsed.streets) {
    for (const a of st.acts) {
      if (a.kind === "post") posts.push(a);
    }
  }
  const cols: RouteCol[] = [
    { key: "blinds", label: "盲注(前注)", pot: 0, acts: posts, boardNew: "", board2New: "", board3New: "" },
  ];
  for (const st of parsed.streets) {
    const rest = st.acts.filter((a) => a.kind !== "post");
    if (rest.length || st.board || st.board2 || st.board3) {
      cols.push({ key: st.key, label: st.label, pot: st.potBefore, acts: rest, boardNew: st.boardNew || "", board2New: st.board2New || "", board3New: st.board3New || "" });
    }
  }
  return cols;
}

type TlEntry = { type: "marker" | "act"; streetKey: string; colKey?: string; actIdx?: number; kind?: string };

/** 播放时间线：直接从翻牌前第一个动作开始（盲注不进时间线，底池/投入的初始值
    由播放推演侧预置计入盲注），其后各街 = 街标记（发牌）+ 该街全部动作 */
function buildTimeline(cols: RouteCol[]): TlEntry[] {
  const tl: TlEntry[] = [];
  for (const col of cols) {
    if (col.key === "blinds") continue;
    if (col.key !== "preflop") tl.push({ type: "marker", streetKey: col.key });
    col.acts.forEach((a, i) => tl.push({ type: "act", streetKey: col.key, colKey: col.key, actIdx: i, kind: a.kind }));
  }
  return tl;
}

/** 一条街的路线列（items 为本列动作 + 各自时间线下标）。
    路线全程完整保留（播放时也不隐藏未来动作），只高亮当前步 */
function StreetColumn({ col, bb, items, playIdx, seekable, onSeek }: {
  col: RouteCol;
  bb: number;
  items: { act: ReplayAct; tl: number }[];
  playIdx: number | null; // null = 未进入播放（无高亮）
  seekable: boolean;
  onSeek?: (tl: number) => void;
}) {
  // 全下摊牌后各街已无行动，改为画出本街新发的牌，而不是留一个「—」；
  // 跑两次的手第二行以 ② 前缀叠放第二条牌面，跑三次再叠 ③
  const boardRows = !col.acts.length && (col.boardNew || col.board2New || col.board3New) ? (
    <>
      {col.boardNew ? (
        <span className="b2rp-street-cards"><Cards text={col.boardNew} size="sm" /></span>
      ) : null}
      {col.board2New ? (
        <span className="b2rp-street-cards"><span className="b2rp-rit-tag">②</span><Cards text={col.board2New} size="sm" /></span>
      ) : null}
      {col.board3New ? (
        <span className="b2rp-street-cards"><span className="b2rp-rit-tag">③</span><Cards text={col.board3New} size="sm" /></span>
      ) : null}
    </>
  ) : null;
  const body = items.length ? (
    items.map(({ act, tl }) => (
      <ActChip
        key={`${col.key}-${tl}`}
        act={act}
        bb={bb}
        now={playIdx !== null && tl === playIdx}
        seekable={seekable}
        onSeek={onSeek ? () => onSeek(tl) : undefined}
      />
    ))
  ) : boardRows ? (
    boardRows
  ) : (
    <span className="b2rp-empty">—</span>
  );
  return (
    <div className={`b2rp-col${col.key === "blinds" ? " b2rp-col--blinds" : ""}`}>
      <div className="b2rp-col-head">
        <span className="b2rp-col-title">{col.label}</span>
        {col.pot > 0 ? <span className="b2rp-col-pot">{amountToBB(col.pot, bb)} BB</span> : null}
      </div>
      <div className="b2rp-col-body">{body}</div>
    </div>
  );
}

/** 桌面动作牌文案：与扑克客户端一致的 FOLD/CHECK/CALL/BET/RAISE 大写标签（弃牌弱化） */
function actTagOf(a: ReplayAct, bb: number): { label: string; dim: boolean } {
  const n = amountToBB(a.amt, bb);
  switch (a.kind) {
    case "fold": return { label: "FOLD", dim: true };
    case "check": return { label: "CHECK", dim: false };
    case "call": return { label: "CALL" + (n ? " " + n : ""), dim: false };
    case "bet": return { label: "BET" + (n ? " " + n : ""), dim: false };
    case "raise": return { label: "RAISE" + (n ? " " + n : ""), dim: false };
    case "post": return { label: a.name === "小盲" ? "SB" : a.name === "大盲" ? "BB" : "ANTE", dim: true };
    case "collect": return { label: "WIN" + (n ? " " + n : ""), dim: false };
    default: return { label: a.name, dim: false };
  }
}

/** 环形座位：按索引均分圆周（Hero 恒在正下方 90° 起） */
function SeatView({ seat, idx, n, bb, winList, heroWon, heroCards, showWin, showOppCards, acting, actTag, folded }: {
  seat: { seat: number; name: string; stack: number; pos: string; isHero: boolean; isBtn: boolean; cards: string };
  idx: number;
  n: number;
  bb: number;
  winList: string[];
  heroWon: boolean;
  heroCards: string;
  showWin: boolean; // 播放中未收池不亮 WIN
  showOppCards: boolean; // 播放中对手底牌到摊牌/收池才亮
  acting: boolean; // 播放中：该座位是当前动作的行动者
  actTag: { label: string; dim: boolean } | null; // 桌面动作牌（FOLD/BET/CALL…）
  folded: boolean; // 播放中已弃牌：整座 50% 透明
}) {
  const ang = ((90 + (360 * idx) / n) * Math.PI) / 180;
  const lx = `${(50 + 36 * Math.cos(ang)).toFixed(2)}%`;
  const ty = `${(50 + 30 * Math.sin(ang)).toFixed(2)}%`;
  const isWin = (winList || []).indexOf(seat.name) >= 0;
  const cards = seat.isHero ? (seat.cards || heroCards || "") : (showOppCards ? seat.cards : "");
  return (
    <div
      className={`b2rp-seat${seat.isHero ? " b2rp-seat--hero" : ""}${isWin && showWin ? " b2rp-seat--winner" : ""}${acting ? " b2rp-seat--acting" : ""}${folded ? " b2rp-seat--folded" : ""}`}
      style={{ left: lx, top: ty }}
    >
      {cards ? <div className="b2rp-seat-cards"><Cards text={cards} size="lg" /></div> : null}
      <div className="b2rp-seat-box">
        <span className="b2rp-avatar">
          <b
            className={
              "b2rp-avatar-i" +
              (seat.pos ? ` b2rp-avatar-i--pos${seat.pos.length > 3 ? " b2rp-avatar-i--sm" : ""}` : "")
            }
          >
            {seat.pos || String(seat.name || "?").charAt(0).toUpperCase()}
          </b>
          {seat.isBtn ? <span className="b2rp-dealer">D</span> : null}
          <span className="b2rp-seat-no">{seat.seat}</span>
        </span>
        <span className="b2rp-seat-nm">
          <span className="b2rp-seat-name">{seat.isHero ? "Hero" : seat.name}</span>
        </span>
        <span className="b2rp-seat-stack">{amountToBB(seat.stack, bb)} BB</span>
      </div>
      {showWin && ((seat.isHero && heroWon) || isWin) ? <span className="b2rp-win">WIN</span> : null}
      {actTag ? (
        <span className={"b2rp-act-tag" + (actTag.dim ? " b2rp-act-tag--dim" : "")}>{actTag.label}</span>
      ) : null}
    </div>
  );
}

/** 播放条小图标（线性，跟 currentColor） */
function PlayIcon({ kind }: { kind: "start" | "play" | "pause" | "step" }) {
  const common = { width: 12, height: 12, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true as const };
  if (kind === "start") {
    return <svg {...common}><path d="M6 5h2.4v14H6zM20 5v14L9.6 12z" /></svg>;
  }
  if (kind === "play") {
    return <svg {...common}><path d="M7 4.8v14.4L20 12z" /></svg>;
  }
  if (kind === "pause") {
    return <svg {...common}><path d="M6.5 5H10v14H6.5zM14 5h3.5v14H14z" /></svg>;
  }
  return <svg {...common}><path d="M5 4.8v14.4L15.4 12z" /><path d="M17.6 5H20v14h-2.4z" /></svg>;
}

const STREET_LABELS: Record<string, string> = {
  blinds: "盲注",
  preflop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
};

export default function HandReplayModal({
  row,
  onClose,
  posLabel,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: { row: ReplayRowData | null; onClose: () => void } & ReplayNavProps) {
  // 播放态：playIdx=null = 未进入播放（完整展示最终局面，与旧行为一致）；
  // 进入后 -1 = 已发牌前，0..N-1 = 时间线已推进到的步
  const [playIdx, setPlayIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  // 数据解析与时间线（row 为空时全部空转，hooks 顺序恒定）
  const parsed = row ? parseHandForReplay(row.raw) : null;
  const bb = (() => {
    const parts = (row?.stakes || "").split("/");
    return parts.length > 1 ? numOr0(parts[1]) : 0;
  })();
  const cols = parsed ? buildCols(parsed) : [];
  const timeline = parsed ? buildTimeline(cols) : [];
  const tlLen = timeline.length;

  // Esc 关闭 / ← → 顺序翻手 / Space 播放暂停：弹窗存活期间挂全局键监听
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrev?.();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext?.();
      } else if (e.key === " ") {
        // 焦点在按钮上时交给原生 click（避免双触发）
        if (t && t.tagName === "BUTTON") return;
        e.preventDefault();
        if (playIdx === null || playIdx >= tlLen - 1) {
          setPlayIdx(-1);
          setPlaying(true);
        } else {
          setPlaying((p) => !p);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, onClose, onPrev, onNext, playIdx, tlLen]);

  // 换手（‹ › / ← →）时退出播放态。
  // 用 raw 文本做换手信号而非 row 对象身份：HandLogPanel 每次渲染都重建 row
  // 字面量，EV 后台补算每批触发的父级重渲染都会被误判成「换手」，播放中的
  // 回放每 1~2 秒被强制回到未播放态（2026-11-03 审查 P1）
  const rowKey = row ? row.raw : "";
  useEffect(() => {
    setPlayIdx(null);
    setPlaying(false);
  }, [rowKey]);

  // 播放推进：定时器只负责 +1，到尾由下面的 effect 停
  useEffect(() => {
    if (!playing || tlLen === 0) return;
    const t = setInterval(() => {
      setPlayIdx((cur) => (cur === null || cur >= tlLen - 1 ? cur : cur + 1));
    }, 750);
    return () => clearInterval(t);
  }, [playing, tlLen]);
  useEffect(() => {
    if (playing && playIdx !== null && playIdx >= tlLen - 1) setPlaying(false);
  }, [playing, playIdx, tlLen]);

  // 当前步高亮的动作滚入视野（路线列动作多、弹窗内滚动时保持可见）
  useEffect(() => {
    if (playIdx === null || playIdx < 0) return;
    const el = document.querySelector(".b2rp-chip--now");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [playIdx]);

  if (!row || !parsed) return null;

  // 环形座次：旋转数组让 Hero 排第一（画在正下方）
  const seats = parsed.seats;
  const heroIdx = seats.findIndex((s) => s.isHero);
  const ring = heroIdx > 0
    ? Array.from({ length: seats.length }, (_, i) => seats[(heroIdx + i) % seats.length])
    : seats.slice();
  const ringN = ring.length || 1;

  // 动作 → 时间线下标（渲染时判断可见/高亮/跳转）
  const tlOfAct = new Map<string, number>();
  timeline.forEach((e, i) => {
    if (e.type === "act") tlOfAct.set(`${e.colKey}:${e.actIdx}`, i);
  });

  const active = playIdx !== null;
  const atEnd = active && playIdx >= tlLen - 1;

  // 播放中已揭示的信息：最后经过的街标记 → 该街累计公共牌；收池动作 → WIN/对手亮牌；
  // 同时按已揭示动作推演当前底池与桌面动作牌（口径与解析器一致：post/call/bet 加 amt，
  // raise 加 amt-街内已投入；街标记重置投入）。盲注不进时间线——底池与各人投入
  // 的初始值直接按全部 post 预置（等同解析器在翻牌前街内的处理）。
  // 动作牌驻留规则：非弃牌动作一直挂在座位上，直到同一玩家做出新动作（替换）或到达下一条街（清空）；
  // FOLD 只在当前步临时显示，不驻留
  let lastStreetKey = "";
  let collectSeen = false;
  // 红包桌的注入从第一步就在池里（玩家投入之外的底数）
  let livePot = parsed ? parsed.blindsTotal + parsed.cashDrop : 0;
  let liveCommit: Record<string, number> = {};
  const tagMap = new Map<number, { label: string; dim: boolean }>();
  const foldedSeats = new Set<number>();
  if (parsed && active) {
    for (const st of parsed.streets) {
      for (const a of st.acts) {
        if (a.kind === "post") liveCommit[a.actor] = (liveCommit[a.actor] || 0) + a.amt;
      }
    }
    for (let i = 0; i <= playIdx && i < tlLen; i++) {
      const e = timeline[i];
      if (e.type === "marker") {
        liveCommit = {};
        tagMap.clear();
        lastStreetKey = e.streetKey;
        continue;
      }
      if (e.kind === "collect") collectSeen = true;
      const col = cols.find((c) => c.key === e.colKey);
      const a = col ? col.acts[e.actIdx ?? -1] : null;
      if (!a) continue;
      if (a.kind === "post" || a.kind === "call" || a.kind === "bet") {
        liveCommit[a.actor] = (liveCommit[a.actor] || 0) + a.amt;
        livePot += a.amt;
      } else if (a.kind === "raise") {
        const prev = liveCommit[a.actor] || 0;
        livePot += a.amt - prev;
        liveCommit[a.actor] = a.amt;
      }
      if (a.kind !== "fold" && typeof a.seat === "number") {
        tagMap.set(a.seat, actTagOf(a, bb));
      }
      // 弃牌后整座 50% 透明（标签瞬时规则不变，弃牌者的暗淡持续到本手结束）
      if (a.kind === "fold" && typeof a.seat === "number") {
        foldedSeats.add(a.seat);
      }
    }
  }
  const effStreet = lastStreetKey ? parsed.streets.find((s) => s.key === lastStreetKey) : null;
  const effBoard = active ? (effStreet ? effStreet.board : "") : parsed.board;
  const effBoard2 = active ? (effStreet ? effStreet.board2 : "") : parsed.board2;
  const effBoard3 = active ? (effStreet ? effStreet.board3 : "") : parsed.board3;
  // 播放完整走完也把牌全亮（兜底：没有 collect 动作的手不至于一直蒙着）
  const showdownSeen = !active || collectSeen || atEnd;
  // 桌面底池跟随当前步（收池后定格为最终收池合计；未跟注退款发生在街尾，误差只在收池前瞬态存在）
  const shownPot = active ? (collectSeen ? row.pot : livePot) : row.pot;

  // 当前高亮的动作（所在列 + 列内下标）及其行动者座位（桌面同步亮圈）
  const nowEntry = active && playIdx >= 0 ? timeline[playIdx] : null;
  const nowColKey = nowEntry && nowEntry.type === "act" ? nowEntry.colKey! : null;
  const nowActIdx = nowEntry && nowEntry.type === "act" ? nowEntry.actIdx! : -1;
  const nowAct = nowColKey !== null ? cols.find((c) => c.key === nowColKey)?.acts[nowActIdx] ?? null : null;
  const actingSeatNo = nowAct && typeof nowAct.seat === "number" ? nowAct.seat : null;
  const nowActTag = nowAct ? actTagOf(nowAct, bb) : null;

  const streetLabel = active && playIdx >= 0
    ? nowEntry && nowEntry.type === "marker"
      ? STREET_LABELS[nowEntry.streetKey] || ""
      : lastStreetKey
        ? STREET_LABELS[lastStreetKey] || ""
        : "翻牌前"
    : "";

  const startPlay = () => {
    if (playIdx === null || playIdx >= tlLen - 1) {
      setPlayIdx(-1); // 从头播 / 重播
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };
  const stepOnce = () => {
    setPlaying(false);
    setPlayIdx((cur) => (cur === null ? 0 : Math.min(cur + 1, tlLen - 1)));
  };
  const seekTo = (tl: number) => {
    setPlaying(false);
    setPlayIdx(tl);
  };

  const winList = parsed.winners || [];
  const heroWon = !!row.heroWon;

  return (
    <div className="b2rp-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="b2rp-panel" onClick={(e) => e.stopPropagation()}>
        <div className="b2rp-head">
          <span className="b2rp-title">单手回放</span>
          <span className="b2rp-meta">
            {row.time} · {row.stakes}
            {parsed.maxSeats ? ` · ${parsed.maxSeats}-max` : ""}
          </span>
          {parsed.cashDrop > 0 ? (
            <span className="b2rp-meta b2rp-meta--redpacket" title={`红包桌：每手庄家向底池额外注入 ${amountToBB(parsed.cashDrop, bb)} BB`}>
              🧧 红包桌
            </span>
          ) : null}
          <span className="b2rp-meta">底池 {amountToBB(row.pot, bb)} BB</span>
          {posLabel ? <span className="b2rp-meta b2rp-nav-count">{posLabel}</span> : null}
          <button type="button" className="b2rp-close" onClick={onClose} title="关闭">✕</button>
        </div>

        <div className="b2rp-stage">
          {onPrev ? (
            <button
              type="button"
              className="b2rp-nav b2rp-nav--prev"
              onClick={onPrev}
              disabled={!hasPrev}
              title="上一手（←）"
              aria-label="上一手"
            >‹</button>
          ) : null}
          {onNext ? (
            <button
              type="button"
              className="b2rp-nav b2rp-nav--next"
              onClick={onNext}
              disabled={!hasNext}
              title="下一手（→）"
              aria-label="下一手"
            >›</button>
          ) : null}
          <div className={"b2rp-felt" + (parsed.cashDrop > 0 ? " b2rp-felt--redpacket" : "")}><div className="b2rp-felt-inner" /></div>
          <div className="b2rp-center">
            <div className="b2rp-board">
              {effBoard3 ? (
                // 跑三次：三条牌面上下叠放，① ② ③ 区分
                <div className="b2rp-rit-col">
                  <div className="b2rp-rit-row"><span className="b2rp-rit-tag">①</span><Cards text={effBoard} size="lg" /></div>
                  <div className="b2rp-rit-row"><span className="b2rp-rit-tag">②</span><Cards text={effBoard2} size="lg" /></div>
                  <div className="b2rp-rit-row"><span className="b2rp-rit-tag">③</span><Cards text={effBoard3} size="lg" /></div>
                </div>
              ) : effBoard2 ? (
                // 跑两次：两条牌面上下叠放，① ② 区分（只发生在两人全押的大底池）
                <div className="b2rp-rit-col">
                  <div className="b2rp-rit-row"><span className="b2rp-rit-tag">①</span><Cards text={effBoard} size="lg" /></div>
                  <div className="b2rp-rit-row"><span className="b2rp-rit-tag">②</span><Cards text={effBoard2} size="lg" /></div>
                </div>
              ) : effBoard ? (
                <Cards text={effBoard} size="lg" />
              ) : (
                <span className="b2rp-none">未发出公共牌</span>
              )}
            </div>
            <div className="b2rp-pot">
              <span className="b2rp-pot-dot" />
              <span className="b2rp-pot-num">{amountToBB(shownPot, bb)} BB</span>
            </div>
          </div>
          {ring.map((seat, idx) => (
            <SeatView
              key={seat.seat}
              seat={seat}
              idx={idx}
              n={ringN}
              bb={bb}
              winList={winList}
              heroWon={heroWon}
              heroCards={row.cards}
              showWin={showdownSeen}
              showOppCards={showdownSeen}
              acting={actingSeatNo !== null && seat.seat === actingSeatNo}
              actTag={tagMap.get(seat.seat) ?? (actingSeatNo === seat.seat && nowAct && nowAct.kind === "fold" ? nowActTag : null)}
              folded={foldedSeats.has(seat.seat)}
            />
          ))}
        </div>

        {tlLen > 0 ? (
          <div className="b2rp-playbar">
            <button
              type="button"
              className="b2rp-pbtn"
              onClick={() => { setPlaying(false); setPlayIdx(-1); }}
              disabled={!active || playIdx < 0}
              title="回到开头"
              aria-label="回到开头"
            ><PlayIcon kind="start" /></button>
            <button
              type="button"
              className="b2rp-pbtn b2rp-pbtn--play"
              onClick={startPlay}
              title={playing ? "暂停（Space）" : "播放（Space）"}
              aria-label={playing ? "暂停" : "播放"}
            ><PlayIcon kind={playing ? "pause" : "play"} /></button>
            <button
              type="button"
              className="b2rp-pbtn"
              onClick={stepOnce}
              disabled={atEnd}
              title="下一步"
              aria-label="下一步"
            ><PlayIcon kind="step" /></button>
            <span className="b2rp-play-pos">
              {active ? `第 ${playIdx + 1} / ${tlLen} 步` : `共 ${tlLen} 步`}
              {streetLabel ? <span className="b2rp-play-street"> · {streetLabel}</span> : null}
            </span>
            {!active ? <span className="b2rp-play-hint">逐动作重演：底池/公共牌跟随当前步，桌面亮出行动者；点任意动作可跳转</span> : null}
          </div>
        ) : null}

        <div className="b2rp-route">
          {cols.map((col, i) => {
            const items = col.acts.map((a, j) => ({ act: a, tl: tlOfAct.get(`${col.key}:${j}`) ?? -1 }));
            return (
              <StreetColumn
                key={`${col.key}-${i}`}
                col={col}
                bb={bb}
                items={items}
                playIdx={active ? playIdx : null}
                seekable
                onSeek={seekTo}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
