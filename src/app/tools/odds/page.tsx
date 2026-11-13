"use client";

import { useState, useCallback, useRef, useEffect, Fragment, type CSSProperties } from "react";
import Navbar from "@/app/components/Navbar";
import ToolHeader from "@/app/components/ToolHeader";
import SiteFooter from "@/app/components/SiteFooter";
import { parseCard } from "@/lib/poker";
import {
  parseStoveInputs,
  parsePlayerInput,
  createStoveJob,
  type StoveOutcome,
  type Combo,
} from "@/lib/stoveEquity";

/* 玩家配色（站内语义色扩展：P1 绿 / P2 红 / 其余低饱和） */
const PLAYER_COLORS = [
  { main: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.35)", bar: "rgba(34,197,94,0.75)" },
  { main: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.35)", bar: "rgba(239,68,68,0.7)" },
  { main: "#c4a455", bg: "rgba(168,139,70,0.1)", border: "rgba(168,139,70,0.4)", bar: "rgba(168,139,70,0.8)" },
  { main: "#60a5fa", bg: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.35)", bar: "rgba(96,165,250,0.7)" },
  { main: "#c084fc", bg: "rgba(192,132,252,0.08)", border: "rgba(192,132,252,0.35)", bar: "rgba(192,132,252,0.7)" },
  { main: "#2dd4bf", bg: "rgba(45,212,191,0.08)", border: "rgba(45,212,191,0.35)", bar: "rgba(45,212,191,0.7)" },
];

const RUNS_DEFAULT = 1_000_000;

/* 公共牌选牌面板：52 张牌、按花色着色（♠白/♥红/♦蓝/♣绿 的暗色适配） */
const PICKER_RANKS = "AKQJT98765432";
const SUIT_META = [
  { sym: "♠", color: "#e4e4e7" }, // s
  { sym: "♥", color: "#ef4444" }, // h
  { sym: "♦", color: "#60a5fa" }, // d
  { sym: "♣", color: "#4ade80" }, // c
];

/** "As" → 花色着色的牌面 */
function cardFace(code: string) {
  const c = parseCard(code);
  if (c < 0) return code;
  const rank = "23456789TJQKA"[c % 13];
  const s = Math.floor(c / 13);
  return (
    <span style={{ color: SUIT_META[s].color }}>
      {rank}
      {SUIT_META[s].sym}
    </span>
  );
}

/* ── 13×13 范围矩阵 ─────────────────────────────────────────── */
const RANKS_DISPLAY = "AKQJT98765432"; // 矩阵行列顺序
const RANKS_ENGINE = "23456789TJQKA"; // 引擎 rank 顺序（2=0 … A=12）

/** 组合列表 → 选中格（row=高牌显示位, col=低牌显示位；上三角=同花、下三角=杂色，与格子标签一致） */
function combosToCells(combos: Combo[]): Set<number> {
  const cells = new Set<number>();
  for (const c of combos) {
    const r1 = c.c1 % 13;
    const r2 = c.c2 % 13;
    const hi = Math.max(r1, r2);
    const lo = Math.min(r1, r2);
    const suited = Math.floor(c.c1 / 13) === Math.floor(c.c2 / 13);
    const row = RANKS_DISPLAY.indexOf(RANKS_ENGINE[hi]);
    const col = RANKS_DISPLAY.indexOf(RANKS_ENGINE[lo]);
    cells.add(suited ? row * 13 + col : col * 13 + row);
  }
  return cells;
}

/** 选中格 → 规范范围文本（col>row 同花，col<row 杂色，对角=对子） */
function cellsToText(cells: Set<number>): string {
  const cellList = [...cells].sort((a, b) => a - b);
  const pairs: string[] = [];
  const suited: string[] = [];
  const offsuit: string[] = [];
  for (const cell of cellList) {
    const row = Math.floor(cell / 13);
    const col = cell % 13;
    if (row === col) pairs.push(RANKS_DISPLAY[row] + RANKS_DISPLAY[row]);
    else if (col > row) suited.push(RANKS_DISPLAY[row] + RANKS_DISPLAY[col] + "s");
    else offsuit.push(RANKS_DISPLAY[col] + RANKS_DISPLAY[row] + "o");
  }
  return [...pairs, ...suited, ...offsuit].join(", ");
}

const GRID_CELL_SIZE = 34;

export default function EquityCalculator() {
  const [playerTexts, setPlayerTexts] = useState<string[]>(["AcAd", "KcKd"]);
  const [gridOpen, setGridOpen] = useState<boolean[]>([false, false]);
  const [board, setBoard] = useState<string[]>(["", "", "", "", ""]);
  const [dead, setDead] = useState("");
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<StoveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<MessageChannel | null>(null);
  const ranOnce = useRef(false);

  // dev StrictMode 双挂载：首次挂载建的 channel 在模拟卸载时被关，若 ranOnce 不复位，
  // 二次挂载不再 run()，已排队消息全丢、页面永久停在「计算中…」（仅 dev，生产无 StrictMode）
  useEffect(() => () => { channelRef.current?.port1.close(); ranOnce.current = false; }, []);

  const setPlayer = (i: number, v: string) => {
    const next = [...playerTexts];
    next[i] = v;
    setPlayerTexts(next);
  };
  const setBoardCell = (i: number, v: string) => {
    const next = [...board];
    next[i] = v;
    setBoard(next);
  };

  /* 选牌面板：已被公共牌其他槽位 / 死牌 / 玩家具体手牌占用的牌置灰 */
  const usedPickerCards = (() => {
    const used = new Set<number>();
    board.forEach((b, bi) => {
      if (bi !== activeSlot && b.length === 2) {
        const c = parseCard(b);
        if (c >= 0) used.add(c);
      }
    });
    for (const tok of dead.split(/[\s,]+/)) {
      if (tok.length === 2) {
        const c = parseCard(tok);
        if (c >= 0) used.add(c);
      }
    }
    for (const txt of playerTexts) {
      const pr = parsePlayerInput(txt);
      if (typeof pr === "string" || !pr.combos || pr.combos.length !== 1) continue;
      used.add(pr.combos[0].c1);
      used.add(pr.combos[0].c2);
    }
    return used;
  })();

  const pickCard = (suitIdx: number, rankIdx: number) => {
    if (activeSlot === null) return;
    const code = (PICKER_RANKS[rankIdx] + "shdc"[suitIdx]).toUpperCase();
    const next = [...board];
    next[activeSlot] = code;
    setBoard(next);
    // 选完自动跳到下一个空槽位；没有则收起
    const empties = next
      .map((b, bi) => ({ b, bi }))
      .filter((x) => !x.b && x.bi !== activeSlot)
      .map((x) => x.bi);
    const target = empties.find((bi) => bi > activeSlot) ?? empties[0];
    setActiveSlot(target === undefined ? null : target);
  };

  const addPlayer = () => {
    if (playerTexts.length >= 6) return;
    setPlayerTexts([...playerTexts, ""]);
    setGridOpen([...gridOpen, false]);
  };
  const removePlayer = (i: number) => {
    if (playerTexts.length <= 2) return;
    setPlayerTexts(playerTexts.filter((_, k) => k !== i));
    setGridOpen(gridOpen.filter((_, k) => k !== i));
  };

  /**
   * 把某玩家的某个 13×13 格子设为 选中/取消，并写回文本框。
   * 合并式更新：可由格子再生的规范类记号（AA/AKs/AKo）按选中集重写；
   * 携带额外语义的记号（具体花色 AsKs、带权 AcAs=0.75、梯子 ATs+）只要
   * 不被本次点击移除就原样保留，避免点击矩阵静默改写用户输入。
   */
  const setCell = (playerIdx: number, cell: number, value: boolean) => {
    setPlayerTexts((prev) => {
      const text = prev[playerIdx] ?? "";
      const parsed = parsePlayerInput(text);
      const cells = typeof parsed === "string" ? new Set<number>() : combosToCells(parsed.combos ?? []);
      if (value ? cells.has(cell) : !cells.has(cell)) return prev; // 点击无变化，不做任何重写
      const nextCells = new Set(cells);
      if (value) nextCells.add(cell);
      else nextCells.delete(cell);

      const removedCells = value ? new Set<number>() : new Set([cell]);
      const kept: string[] = [];
      const keptCells = new Set<number>();
      if (typeof parsed !== "string") {
        for (const tok of text.split(/[,\s]+/).filter(Boolean)) {
          const base = tok.replace(/[:=][\d.]+$/, "");
          // 规范类记号可由 cellsToText 再生，交给下方重写；其余记号尝试原样保留
          const canonical = /^(22|33|44|55|66|77|88|99|TT|JJ|QQ|KK|AA)$/.test(base) || /^[2-9TJQKA][2-9TJQKA][so]$/.test(base);
          if (canonical) continue;
          const tr = parsePlayerInput(tok);
          if (typeof tr === "string" || !tr.combos) continue;
          const tokCells = combosToCells(tr.combos);
          if ([...tokCells].some((c) => removedCells.has(c))) continue; // 该记号被本次移除波及 → 丢弃
          kept.push(tok);
          for (const c of tokCells) keptCells.add(c);
        }
      }
      for (const c of keptCells) nextCells.delete(c); // 保留的记号已表达这些格，规范部分不重复
      const next = [...prev];
      next[playerIdx] = [...kept, cellsToText(nextCells)].filter(Boolean).join(", ");
      return next;
    });
  };

  /* 拖动刷选：按下时按起点格子确定 加/减 模式，划过的格子按该模式处理 */
  const dragRef = useRef<{ player: number; mode: "add" | "remove" } | null>(null);
  useEffect(() => {
    const stop = () => {
      dragRef.current = null;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (running) return; // 计算中不允许重置输入，避免结果与输入错位
    channelRef.current?.port1.close();
    channelRef.current = null;
    setActiveSlot(null);
    setPlayerTexts([...p.players]);
    setGridOpen(p.players.map(() => false));
    setBoard([...p.board]);
    setDead(p.dead);
    setResult(null);
    setError(null);
    setRunning(false);
    setProgress(0);
  };

  /* 全清空：玩家留两个空槽（最少 2 人）、公共牌 / 死牌 / 结果全清 */
  const clearAll = () => {
    if (running) return; // 同 applyPreset：计算中不允许重置输入
    channelRef.current?.port1.close();
    channelRef.current = null;
    setActiveSlot(null);
    setPlayerTexts(["", ""]);
    setGridOpen([false, false]);
    setBoard(["", "", "", "", ""]);
    setDead("");
    setResult(null);
    setError(null);
    setRunning(false);
    setProgress(0);
  };

  const run = useCallback(() => {
    if (running) return;
    setError(null);
    setResult(null);
    setProgress(0);

    const parsed = parseStoveInputs(playerTexts, board, dead);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setRunning(true);
    // MessageChannel 宏任务驱动：标签页在后台/被遮挡时不会被 rAF 冻结或定时器节流
    const job = createStoveJob(parsed.players, parsed.board, parsed.dead, { runs: RUNS_DEFAULT });
    const channel = new MessageChannel();
    channelRef.current = channel;
    const tick = () => {
      const sliceStart = performance.now();
      while (!job.finished && performance.now() - sliceStart < 12) {
        job.step(2_000);
      }
      setProgress(job.done / job.total);
      if (job.finished) {
        const outcome = job.result();
        // error 非空说明没有任何合法发牌（组合完全重叠等），不能当作 0% 结果展示
        if (outcome.error) setError(outcome.error);
        setResult(outcome.error ? null : outcome);
        setRunning(false);
        channel.port1.close();
      } else {
        channel.port2.postMessage(null);
      }
    };
    channel.port1.onmessage = tick;
    channel.port2.postMessage(null);
  }, [playerTexts, board, dead, running]);

  /* 首帧自动算一次默认场景 */
  useEffect(() => {
    if (!ranOnce.current) {
      ranOnce.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "0.75rem",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "0.5rem",
    color: "#f4f4f5",
    fontSize: "0.9375rem",
    fontFamily: "var(--font-mono)",
  };
  const labelStyle: CSSProperties = {
    color: "#a1a1aa",
    fontSize: "0.75rem",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "0.5rem",
  };

  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="工具台 / 概率工具"
            title="Equity计算器"
            glyph="equity"
          />

          {/* ── 输入区 ── */}
          <div className="card" style={{ padding: "1.75rem", marginBottom: "2rem" }}>
            {/* 玩家 */}
            {playerTexts.map((text, i) => {
              const c = PLAYER_COLORS[i];
              const parsed = parsePlayerInput(text);
              const comboCount = typeof parsed === "string" ? null : parsed.combos ? parsed.combos.length : 1326;
              const selectedCells = typeof parsed === "string" ? new Set<number>() : combosToCells(parsed.combos ?? []);
              return (
                <div key={i} style={{ marginBottom: i === playerTexts.length - 1 ? "1.5rem" : "1rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                    <span style={{ display: "inline-block", width: "0.5rem", height: "0.9rem", borderRadius: "2px", background: c.main }} />
                    <span style={{ color: c.main, fontSize: "0.8125rem", fontWeight: 600 }}>玩家 {i + 1}</span>
                    {comboCount !== null && (
                      <span style={{ color: "#71717a", fontSize: "0.75rem" }}>
                        {comboCount} 组合{comboCount === 1326 ? "（随机）" : ""}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    {playerTexts.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removePlayer(i)}
                        aria-label={`移除玩家 ${i + 1}`}
                        style={{
                          padding: "0.25rem 0.55rem",
                          background: "transparent",
                          border: "1px solid rgba(255,255,255,0.12)",
                          borderRadius: "0.375rem",
                          color: "#71717a",
                          fontSize: "0.75rem",
                          cursor: "pointer",
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <input
                      value={text}
                      onChange={(e) => setPlayer(i, e.target.value)}
                      readOnly={running}
                      aria-label={`玩家 ${i + 1} 手牌范围`}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="如 AsKs、AKs、QQ+、22-55、AcAs=0.75，留空 = 随机手牌"
                      style={{ ...inputStyle, flex: 1, width: "auto", background: c.bg, borderColor: c.border, opacity: running ? 0.6 : 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = [...gridOpen];
                        next[i] = !next[i];
                        setGridOpen(next);
                      }}
                      className={`range-toggle-btn${gridOpen[i] ? " is-open" : ""}`}
                    >
                      {gridOpen[i] ? "收起范围" : "打开范围"}
                    </button>
                  </div>
                  {typeof parsed === "string" && (
                    <div style={{ color: "#ef4444", fontSize: "0.75rem", marginTop: "0.3rem" }}>{parsed}</div>
                  )}
                  {gridOpen[i] && (
                    <div style={{ marginTop: "0.75rem", padding: "0.75rem", background: "rgba(0,0,0,0.25)", borderRadius: "0.5rem", overflowX: "auto", userSelect: "none" }}>
                      <div style={{ display: "grid", gridTemplateColumns: `${GRID_CELL_SIZE}px repeat(13, ${GRID_CELL_SIZE}px)`, gap: "2px", width: "fit-content" }}>
                        <div />
                        {RANKS_DISPLAY.split("").map((r) => (
                          <div key={r} style={{ textAlign: "center", color: "#71717a", fontSize: "0.6875rem", lineHeight: `${GRID_CELL_SIZE}px` }}>{r}</div>
                        ))}
                        {RANKS_DISPLAY.split("").map((rowRank, row) => (
                          <Fragment key={`row-${row}`}>
                            <div style={{ color: "#71717a", fontSize: "0.6875rem", lineHeight: `${GRID_CELL_SIZE}px`, textAlign: "center" }}>{rowRank}</div>
                            {RANKS_DISPLAY.split("").map((colRank, col) => {
                              const cell = row * 13 + col;
                              const selected = selectedCells.has(cell);
                              const suited = col > row;
                              const label = row === col ? rowRank + rowRank : suited ? rowRank + colRank + "s" : colRank + rowRank + "o";
                              return (
                                <button
                                  key={cell}
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    if (running) return;
                                    const mode = selectedCells.has(cell) ? "remove" : "add";
                                    dragRef.current = { player: i, mode };
                                    setCell(i, cell, mode === "add");
                                  }}
                                  onMouseEnter={() => {
                                    if (running) return;
                                    const drag = dragRef.current;
                                    if (drag && drag.player === i) {
                                      setCell(i, cell, drag.mode === "add");
                                    }
                                  }}
                                  style={{
                                    width: GRID_CELL_SIZE,
                                    height: GRID_CELL_SIZE,
                                    background: selected ? "rgba(168,139,70,0.85)" : "rgba(255,255,255,0.04)",
                                    border: "1px solid rgba(255,255,255,0.06)",
                                    borderRadius: "3px",
                                    color: selected ? "#0a0a0a" : "#a1a1aa",
                                    fontSize: "0.625rem",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    fontFamily: "var(--font-mono)",
                                  }}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </Fragment>
                        ))}
                      </div>
                      <div style={{ color: "#71717a", fontSize: "0.6875rem", marginTop: "0.5rem" }}>
                        点击或拖动选格生成范围；对角=对子，右上=同花，左下=杂色
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {playerTexts.length < 6 && (
              <button
                type="button"
                onClick={addPlayer}
                style={{
                  marginBottom: "1.5rem",
                  padding: "0.45rem 0.9rem",
                  background: "transparent",
                  border: "1px dashed rgba(255,255,255,0.18)",
                  borderRadius: "0.5rem",
                  color: "#a1a1aa",
                  fontSize: "0.8125rem",
                  cursor: "pointer",
                }}
              >
                + 添加玩家（最多 6 人）
              </button>
            )}

            {/* 公共牌 */}
            <div style={{ marginBottom: "1.5rem" }}>
              <div style={labelStyle}>公共牌（可空 = 翻前，点击槽位选牌）</div>
              <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                {[
                  { name: "翻牌", idx: [0, 1, 2] },
                  { name: "转牌", idx: [3] },
                  { name: "河牌", idx: [4] },
                ].map((street) => (
                  <div key={street.name}>
                    <div style={{ color: "#71717a", fontSize: "0.6875rem", marginBottom: "0.3rem" }}>{street.name}</div>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      {street.idx.map((bi) => {
                        const filled = board[bi].length === 2 && parseCard(board[bi]) >= 0;
                        const active = activeSlot === bi;
                        return (
                          <button
                            key={bi}
                            type="button"
                            onClick={() => setActiveSlot(active ? null : bi)}
                            style={{
                              width: "3.4rem",
                              height: "2.6rem",
                              textAlign: "center",
                              background: active ? "rgba(168,139,70,0.18)" : "rgba(255,255,255,0.04)",
                              border: `1px solid ${active ? "rgba(196,164,85,0.7)" : "rgba(255,255,255,0.1)"}`,
                              borderRadius: "0.5rem",
                              fontSize: "1.05rem",
                              fontWeight: 700,
                              fontFamily: "var(--font-mono)",
                              color: filled ? "#f4f4f5" : "#71717a",
                              cursor: "pointer",
                            }}
                          >
                            {filled ? cardFace(board[bi]) : "??"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setBoard(["", "", "", "", ""]);
                    setActiveSlot(null);
                  }}
                  style={{ padding: "0.5rem 0.75rem", background: "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "0.5rem", color: "#71717a", fontSize: "0.75rem", cursor: "pointer" }}
                >
                  清空
                </button>
              </div>

              {activeSlot !== null && (
                <div style={{ marginTop: "0.75rem", padding: "0.75rem", background: "rgba(0,0,0,0.25)", borderRadius: "0.5rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                    <span style={{ color: "#a1a1aa", fontSize: "0.75rem" }}>为第 {activeSlot + 1} 张公共牌选牌</span>
                    <span style={{ flex: 1 }} />
                    {board[activeSlot] && (
                      <button
                        type="button"
                        onClick={() => setBoardCell(activeSlot, "")}
                        style={{ padding: "0.25rem 0.6rem", background: "transparent", border: "1px solid rgba(239,68,68,0.35)", borderRadius: "0.375rem", color: "#ef4444", fontSize: "0.75rem", cursor: "pointer" }}
                      >
                        清除此牌
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveSlot(null)}
                      style={{ padding: "0.25rem 0.6rem", background: "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "0.375rem", color: "#a1a1aa", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      收起
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(13, minmax(32px, 1fr))", gap: "2px" }}>
                    {SUIT_META.map((meta, s) =>
                      PICKER_RANKS.split("").map((r, ri) => {
                        const code = r + "shdc"[s];
                        const isUsed = usedPickerCards.has(parseCard(code));
                        return (
                          <button
                            key={code}
                            type="button"
                            disabled={isUsed}
                            onClick={() => pickCard(s, ri)}
                            style={{
                              height: "2rem",
                              background: isUsed ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)",
                              border: "1px solid rgba(255,255,255,0.07)",
                              borderRadius: "4px",
                              color: isUsed ? "#3f3f46" : meta.color,
                              fontSize: "0.8125rem",
                              fontWeight: 700,
                              fontFamily: "var(--font-mono)",
                              cursor: isUsed ? "default" : "pointer",
                              opacity: isUsed ? 0.5 : 1,
                            }}
                          >
                            {r}
                            {meta.sym}
                          </button>
                        );
                      }),
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 死牌 */}
            <div style={{ marginBottom: "1.5rem" }}>
              <div style={labelStyle}>死牌（可选）</div>
              <input
                value={dead}
                onChange={(e) => setDead(e.target.value.toUpperCase())}
                readOnly={running}
                placeholder="已知的弃牌，如 7h2c"
                style={{ ...inputStyle, opacity: running ? 0.6 : 1 }}
              />
            </div>

            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button onClick={run} disabled={running} className="btn-gold" style={{ flex: 1, justifyContent: "center" }}>
                {running ? `计算中… ${(progress * 100).toFixed(0)}%` : "计算 Equity"}
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={running}
                title="清空玩家 / 公共牌 / 死牌 / 结果"
                style={{
                  padding: "0.75rem 1.1rem",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: "9999px",
                  color: "#a1a1aa",
                  fontSize: "0.875rem",
                  cursor: running ? "default" : "pointer",
                  opacity: running ? 0.5 : 1,
                }}
              >
                清空全部
              </button>
            </div>
            {running && (
              <div style={{ marginTop: "0.75rem", height: "4px", background: "rgba(255,255,255,0.06)", borderRadius: "2px", overflow: "hidden" }}>
                <div style={{ width: `${progress * 100}%`, height: "100%", background: "linear-gradient(90deg, #a88b46, #c4a455)", transition: "width 80ms linear" }} />
              </div>
            )}
            {error && (
              <div style={{ marginTop: "0.75rem", color: "#ef4444", fontSize: "0.8125rem" }}>⚠ {error}</div>
            )}
          <p style={{ color: "#71717a", fontSize: "0.75rem", marginTop: "0.75rem" }}>
            点公共牌槽位从 52 张牌中选牌；玩家手牌写法 As Kh / AsKh（大小写不限）；范围 AKs、QQ+、88-QQ、AJs-A5s；逗号分隔多个组合，可加权 AcAs=0.75
          </p>
          </div>

          {/* ── 结果区 ── */}
          {result && (
            <div role="status" aria-live="polite">
              <div style={{ display: "flex", height: "2rem", borderRadius: "0.5rem", overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)", marginBottom: "1.25rem" }}>
                {result.players.map((p, i) => (
                  <div
                    key={i}
                    title={`玩家 ${i + 1} ${(p.equity * 100).toFixed(2)}%`}
                    style={{ width: `${p.equity * 100}%`, background: PLAYER_COLORS[i].bar, display: "flex", alignItems: "center", justifyContent: "center", color: "#0a0a0a", fontSize: "0.75rem", fontWeight: 700 }}
                  >
                    {(p.equity * 100).toFixed(1)}%
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(150px, 1fr))`, gap: "1rem", marginBottom: "1.25rem" }}>
                {result.players.map((p, i) => (
                  <div key={i} className="card" style={{ textAlign: "center", padding: "1.25rem", borderColor: PLAYER_COLORS[i].border }}>
                    <div style={{ ...labelStyle, color: PLAYER_COLORS[i].main, marginBottom: "0.35rem" }}>玩家 {i + 1}</div>
                    <div style={{ fontSize: "2rem", fontWeight: 800, color: PLAYER_COLORS[i].main }}>{(p.equity * 100).toFixed(2)}%</div>
                    <div style={{ color: "#71717a", fontSize: "0.75rem", marginTop: "0.5rem" }}>
                      独赢 {(p.winPct * 100).toFixed(1)}% · 平分 {(p.tiePct * 100).toFixed(1)}% · 落败 {(p.losePct * 100).toFixed(1)}%
                    </div>
                  </div>
                ))}
              </div>

              <p style={{ color: "#71717a", fontSize: "0.8125rem", textAlign: "center", marginBottom: "2rem" }}>
                {result.meta.mode === "exact"
                  ? `精确穷举 ${result.meta.total.toLocaleString()} 个结果牌面 · ${result.meta.elapsedMs.toFixed(0)} ms · 与 PokerStove ps-eval 对拍一致`
                  : `Monte Carlo ${result.meta.total.toLocaleString()} 次模拟 · ${result.meta.elapsedMs.toFixed(0)} ms · 含范围/随机玩家时自动启用`}
              </p>
            </div>
          )}

          {/* ── 快速测试 ── */}
          <div className="card" style={{ padding: "1.5rem" }}>
            <div style={{ color: "#a1a1aa", fontSize: "0.8125rem", marginBottom: "0.75rem" }}>快速测试</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {PRESETS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  disabled={running}
                  onClick={() => applyPreset(t)}
                  style={{ padding: "0.5rem 1rem", background: "rgba(168,139,70,0.1)", border: "1px solid rgba(168,139,70,0.2)", borderRadius: "0.5rem", color: "#a88b46", fontSize: "0.8125rem", cursor: "pointer", fontFamily: "var(--font-mono)" }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  );
}

const PRESETS = [
  { label: "AA vs KK 翻前", players: ["AcAd", "KcKd"], board: ["", "", "", "", ""], dead: "" },
  { label: "AKs vs QQ+", players: ["AsKs", "QQ+"], board: ["", "", "", "", ""], dead: "" },
  { label: "顶对 vs 同花听牌", players: ["AhKd", "7s6s"], board: ["As", "7d", "2s", "", ""], dead: "" },
  { label: "Set over Set", players: ["AhAd", "AcAs"], board: ["Kh", "7c", "2d", "", ""], dead: "" },
  { label: "3 人 翻前 all-in", players: ["AcAd", "KhKs", "QcQd"], board: ["", "", "", "", ""], dead: "" },
];
