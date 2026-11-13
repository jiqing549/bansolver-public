"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import ToolGlyph from "@/app/components/ToolGlyph";
import JsonLd from "@/app/components/JsonLd";
import {
  FEATURED_TOOL,
  TOOLS,
} from "@/app/components/tools";

/* 开场终幕的浮标（保留原动画里的 emoji 语言） */
const INTRO_TOOLS: { icon: string; title: string; beta?: boolean }[] = [
  { icon: "📈", title: "数据复盘" },
  { icon: "🌳", title: "翻前范围表" },
  { icon: "🎓", title: "翻前训练" },
  { icon: "🧮", title: "翻后Solver" },
  { icon: "🎯", title: "Equity计算器" },
  { icon: "🍅", title: "扑克番茄钟" },
  { icon: "🎮", title: "扑克人生模拟" },
  { icon: "🦑", title: "鱿鱼求解器", beta: true },
];

/* ==============================================
   开场动画时间轴：按顺序自动播放，最后停在终幕
   ============================================== */

type SceneId =
  | "deal"
  | "ban2note"
  | "pomodoro"
  | "equity"
  | "preflop"
  | "lifesim"
  | "curation"
  | "final";

const SCENES: { id: SceneId; ms: number }[] = [
  { id: "deal", ms: 4300 }, // 皇家同花顺发牌 + 站名
  { id: "ban2note", ms: 3800 }, // 牌谱解析 + 柱状图
  { id: "pomodoro", ms: 3600 }, // 番茄钟倒计时环
  { id: "equity", ms: 3800 }, // AKs vs QQ 权益条
  { id: "preflop", ms: 4400 }, // 翻前矩阵扫色 + 出题翻面
  { id: "lifesim", ms: 3600 }, // 骰子 + 人生计数
  { id: "curation", ms: 4000 }, // 免费好站，持续吸纳
  { id: "final", ms: Infinity }, // 终幕，等待点击
];

/* 数字滚动：rAF + ease-out cubic */
function useCountUp(target: number, ms = 1500, delay = 300) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min((t - start - delay) / ms, 1);
      if (p >= 0) setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, delay]);
  return v;
}

/* ==============================================
   场景 0：发牌开场
   ============================================== */

function DealScene() {
  const cards = [
    { rank: "A", suit: "♠", tx: "-9rem", r: "-24deg", d: "0.05s" },
    { rank: "K", suit: "♠", tx: "-4.5rem", r: "-12deg", d: "0.2s" },
    { rank: "Q", suit: "♠", tx: "0rem", r: "0deg", d: "0.35s" },
    { rank: "J", suit: "♠", tx: "4.5rem", r: "12deg", d: "0.5s" },
    { rank: "10", suit: "♠", tx: "9rem", r: "24deg", d: "0.65s" },
  ];
  return (
    <div className="deal-scene">
      <div className="deal-cards">
        <div className="deal-flash" />
        {cards.map((c, i) => (
          <div
            key={i}
            className="pcard"
            style={{ "--tx": c.tx, "--r": c.r, "--d": c.d } as React.CSSProperties}
          >
            <span className="pcard-corner">
              {c.rank}
              <i>{c.suit}</i>
            </span>
            <span className="pcard-suit">{c.suit}</span>
          </div>
        ))}
      </div>
      <p className="intro-kicker anim-fade-up" style={{ animationDelay: "1.5s" }}>
        BanSolver.com
      </p>
      <h1 className="intro-title anim-fade-up" style={{ animationDelay: "1.7s" }}>
        千算Poker <span className="text-gold">免费工具站</span>
      </h1>
      <p className="intro-tag anim-fade-up" style={{ animationDelay: "2s" }}>
        一个还在长的扑克工具站 · 先花半分钟认识它们
      </p>
    </div>
  );
}

/* ==============================================
   通用功能场景骨架：视觉 + 文案
   ============================================== */

function FeatureScene({
  no,
  name,
  head,
  desc,
  children,
}: {
  no: string;
  name: string;
  head: string;
  desc: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="fscene">
      <div className="fscene-visual">{children}</div>
      <div className="intro-cap">
        <p className="intro-cap-label anim-fade-up" style={{ animationDelay: "0.2s" }}>
          {no} · {name}
        </p>
        <h2 className="intro-head anim-fade-up" style={{ animationDelay: "0.45s" }}>
          {head}
        </h2>
        <p className="intro-desc anim-fade-up" style={{ animationDelay: "0.7s" }}>
          {desc}
        </p>
      </div>
    </div>
  );
}


/* 场景 2：Ban2Note 牌谱解析 */
function Ban2NoteScene() {
  const bars = [42, 58, 35, 70, 52, 88, 64, 95, 78];
  return (
    <FeatureScene
      no="02"
      name="数据复盘"
      head="牌谱拖进来，答案吐出来"
      desc="GG / CoinPoker 牌谱一键解析：资金曲线、全面统计、逐动作回放——zip 里套 zip 也吃得下。"
    >
      <div className="bn-wrap">
        <div className="bn-doc">
          <div className="bn-line" style={{ width: "82%" }} />
          <div className="bn-line" style={{ width: "64%", animationDelay: "0.12s" }} />
          <div className="bn-line" style={{ width: "74%", animationDelay: "0.24s" }} />
          <div className="bn-line" style={{ width: "48%", animationDelay: "0.36s" }} />
          <div className="bn-line" style={{ width: "68%", animationDelay: "0.48s" }} />
          <div className="bn-badge">✓ 12,348 手已解析</div>
        </div>
        <div className="bn-bars">
          {bars.map((h, i) => (
            <i key={i} style={{ "--h": `${h}%`, "--d": `${0.3 + i * 0.09}s` } as React.CSSProperties} />
          ))}
        </div>
      </div>
    </FeatureScene>
  );
}

/* 场景 3：番茄钟倒计时环 */
function PomodoroScene() {
  return (
    <FeatureScene
      no="03"
      name="扑克番茄钟"
      head="久坐，是牌手的天敌"
      desc="专注块 + 强制休息，每块记一句手感，到上限自动喊停。专治一坐下就起不来。"
    >
      <div className="pm-wrap">
        <svg viewBox="0 0 120 120" className="pm-svg" aria-hidden="true">
          <circle cx="60" cy="60" r="52" stroke="rgba(255,255,255,0.08)" strokeWidth="7" fill="none" />
          <circle
            cx="60" cy="60" r="52"
            stroke="#c4a455" strokeWidth="7" fill="none" strokeLinecap="round"
            pathLength={100} className="pm-arc" transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="pm-center">
          <span className="pm-tomato">🍅</span>
          <span className="pm-time">25:00</span>
        </div>
      </div>
    </FeatureScene>
  );
}

/* 场景 4：Equity 对决 */
function EquityScene() {
  const pct = useCountUp(46.3, 1600, 900);
  return (
    <FeatureScene
      no="04"
      name="Equity计算器"
      head="翻牌之前，先问概率"
      desc="PokerStove 引擎语义：具体手牌精确穷举、范围 Monte Carlo，2–6 人底池、死牌与加权组合都支持。"
    >
      <div className="eq-wrap">
        <div className="eq-hands">
          <div className="eq-hand eq-hand--left">
            <span className="mcard">A<i>♠</i></span>
            <span className="mcard">K<i>♠</i></span>
          </div>
          <span className="eq-vs">VS</span>
          <div className="eq-hand eq-hand--right">
            <span className="mcard mcard--red">Q<i>♦</i></span>
            <span className="mcard">Q<i>♣</i></span>
          </div>
        </div>
        <div className="eq-bar">
          <div className="eq-fill" style={{ width: `${Math.max(pct, 12)}%` }}>
            <span className="eq-pct">{pct.toFixed(1)}%</span>
          </div>
        </div>
        <div className="eq-names">
          <span className="eq-name--gold">AKs</span>
          <span>QQ</span>
        </div>
      </div>
    </FeatureScene>
  );
}

/* 场景 5：翻前范围表 + 训练
   矩阵色块用确定性伪随机（同 GTO 分布观感：AA 角强、同花偏宽），
   不用 Math.random 以免 hydration 抖动 */
const PF_TONES: ("a" | "b" | "c")[] = Array.from({ length: 169 }, (_, i) => {
  const r = Math.floor(i / 13);
  const c = i % 13;
  const noise = ((r * 73 + c * 149) % 17) / 17;
  const s =
    1 -
    (r + c) / 24 -
    noise * 0.3 +
    (c > r ? 0.16 : 0) - // 同花区更宽
    (c < r ? 0.07 : 0);
  return s > 0.58 ? "a" : s > 0.34 ? "b" : "c";
});

function PreflopScene() {
  return (
    <FeatureScene
      no="05"
      name="翻前 · 范围表与训练"
      head="GTO 翻前，从表到题"
      desc={
        <>
          <span className="no-break">GG Zoom 全树范围表</span>
          ，矩阵里看每手频率与 EV；同款解
          <span className="no-break">随机出题</span>
          ，按位置与 3B/4B 档位练到肌肉记忆。
        </>
      }
    >
      <div className="in-pf-wrap">
        <div className="in-pf-matrix" aria-hidden="true">
          {PF_TONES.map((tone, i) => {
            const r = Math.floor(i / 13);
            const c = i % 13;
            return (
              <span
                key={i}
                className={`in-pf-cell in-pf-cell--${tone}`}
                style={{ "--d": `${(r + c) * 0.045}s` } as React.CSSProperties}
              />
            );
          })}
        </div>
        <div className="in-pf-quiz">
          <span className="in-pf-q-pos">UTG · 开局</span>
          <span className="in-pf-q-hand">
            <span className="mcard">A<i>♠</i></span>
            <span className="mcard">J<i>♠</i></span>
          </span>
          <span className="in-pf-q-flip">
            <span className="in-pf-q-inner">
              <span className="in-pf-q-face in-pf-q-face--q">怎么打？</span>
              <span className="in-pf-q-face in-pf-q-face--a">混合策略 ✓</span>
            </span>
          </span>
          <span className="in-pf-q-stat">训练正确率 87%</span>
        </div>
      </div>
    </FeatureScene>
  );
}

/* 场景 6：人生模拟器 */
function LifesimScene() {
  const talents = useCountUp(18, 1400, 400);
  const events = useCountUp(110, 1600, 650);
  const endings = useCountUp(15, 1800, 900);
  return (
    <FeatureScene
      no="06"
      name="扑克人生模拟"
      head="先在模拟里过完这一行"
      desc="德州扑克职业牌手的一生：从 18 岁入行到 legend 收官，每一局都是独一无二的人生。"
    >
      <div className="ls-wrap">
        <span className="ls-dice">🎲</span>
        <div className="ls-stats">
          <div className="ls-stat anim-fade-up" style={{ animationDelay: "0.3s" }}>
            <b>{Math.round(talents)}</b>
            <span>项天赋</span>
          </div>
          <div className="ls-stat anim-fade-up" style={{ animationDelay: "0.45s" }}>
            <b>{Math.round(events)}+</b>
            <span>个事件</span>
          </div>
          <div className="ls-stat anim-fade-up" style={{ animationDelay: "0.6s" }}>
            <b>{Math.round(endings)}+</b>
            <span>种结局</span>
          </div>
        </div>
      </div>
    </FeatureScene>
  );
}

/* 场景 6：免费好站，持续吸纳 */
function CurationScene() {
  return (
    <FeatureScene
      no="＋"
      name="免费好站"
      head="好用的免费产品，都往这里收"
      desc={
        <>
          五个自研工具只是起点。外面<span className="no-break">好用的免费产品</span>，我们<span className="no-break">持续试、持续收</span>——<span className="no-break">全部免费</span>，<span className="no-break">一个入口</span>。
        </>
      }
    >
      <div className="collect-stage" aria-hidden="true">
        <span className="collect-orbit" />
        <div className="collect-hub">
          <span className="collect-ring" />
          <span className="collect-ring collect-ring--2" />
          <img src="/brand/qiansuan-mark.svg" alt="" />
          <span className="collect-hub-name">千算工具台</span>
        </div>

        <div
          className="collect-card collect-card--top"
          style={{ "--d": "0.2s", "--cd": "0.65s" } as React.CSSProperties}
        >
          <span className="collect-icon">🗺️</span>
          <span className="collect-title">免费 GTO</span>
          <span className="collect-check">✓</span>
        </div>
        <div
          className="collect-card collect-card--left"
          style={{ "--d": "0.5s", "--cd": "0.95s" } as React.CSSProperties}
        >
          <span className="collect-icon">🔁</span>
          <span className="collect-title">免费复盘</span>
          <span className="collect-check">✓</span>
        </div>
        <div
          className="collect-card collect-card--right collect-card--featured"
          style={{ "--d": "0.8s", "--cd": "1.25s" } as React.CSSProperties}
        >
          <span className="collect-icon">🧮</span>
          <span className="collect-title">免费 Solver</span>
          <span className="collect-check">✓</span>
        </div>

        <div className="collect-more">
          <span className="collect-more-plus">＋</span>
          更多好站持续收录
        </div>
      </div>
    </FeatureScene>
  );
}

/* 终幕：站名 + 工具浮标 + 进入提示 */
function FinalScene() {
  return (
    <div className="final-scene">
      <p className="intro-kicker anim-fade-up">BanSolver.com</p>
      <h1 className="intro-title anim-fade-up" style={{ animationDelay: "0.15s" }}>
        千算Poker <span className="text-gold">免费工具站</span>
      </h1>
      <p className="intro-tag anim-fade-up" style={{ animationDelay: "0.3s" }}>
        七个工具 + 外部好站 · 全部免费 · <span className="no-break">登录可同步云端</span>
      </p>
      <div className="final-float anim-fade-up" style={{ animationDelay: "0.5s" }}>
        {INTRO_TOOLS.map((t, i) => (
          <span key={t.title} className="final-float-item" style={{ "--d": `${i * 0.4}s` } as React.CSSProperties}>
            <b>{t.icon}</b>
            <i>{t.title}</i>
            {t.beta && <em className="final-float-beta">内测中</em>}
          </span>
        ))}
      </div>
      <div className="final-cta anim-fade-up" style={{ animationDelay: "0.8s" }}>
        点击任意处，进入工具台
      </div>
    </div>
  );
}

function Scene({ id }: { id: SceneId }) {
  switch (id) {
    case "deal":
      return <DealScene />;
    case "ban2note":
      return <Ban2NoteScene />;
    case "pomodoro":
      return <PomodoroScene />;
    case "equity":
      return <EquityScene />;
    case "preflop":
      return <PreflopScene />;
    case "lifesim":
      return <LifesimScene />;
    case "curation":
      return <CurationScene />;
    case "final":
      return <FinalScene />;
  }
}

/* ==============================================
   主页：开场动画 → 点击 → 卡片导航
   ============================================== */

/* 第一行三并列：主推 + 外站Solver + 翻前范围表；第二行五等列（翻前训练打头，与范围表衔接） */
const TOP_TOOLS = ["solver", "preflop"].map((id) => TOOLS.find((t) => t.id === id)!);
const GRID_TOOLS = ["pftrain", "squid", "equity", "pomodoro", "lifesim"].map(
  (id) => TOOLS.find((t) => t.id === id)!
);

function ToolStatus({ label = "已上线" }: { label?: string }) {
  return (
    <span className="tool-status tool-status--live">
      <i className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/* 主卡底纹：一条示意资金曲线，悬停时重新描一遍 */
function Sparkline() {
  const d =
    "M0 82 L30 74 L60 78 L90 62 L120 68 L150 50 L180 57 L210 40 L240 46 L270 30 L300 36 L330 22 L360 28";
  return (
    <svg
      viewBox="0 0 360 100"
      preserveAspectRatio="none"
      className="spark-svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c4a455" stopOpacity="0.2" />
          <stop offset="1" stopColor="#c4a455" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1="0"
        y1="82"
        x2="360"
        y2="82"
        stroke="rgba(255,255,255,0.1)"
        strokeDasharray="3 6"
        vectorEffect="non-scaling-stroke"
      />
      <path d={`${d} L360 100 L0 100 Z`} fill="url(#spark-fill)" />
      <path
        d={d}
        fill="none"
        stroke="#c4a455"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="spark-line"
      />
      <circle cx="357" cy="28" r="2" fill="#d4b264" />
    </svg>
  );
}

export default function Home() {
  const [sceneIdx, setSceneIdx] = useState(0);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const leavingRef = useRef(false);

  /* 时间轴推进 */
  useEffect(() => {
    if (entered) return;
    const ms = SCENES[sceneIdx]?.ms ?? 0;
    if (!isFinite(ms)) return;
    const t = setTimeout(() => setSceneIdx((i) => Math.min(i + 1, SCENES.length - 1)), ms);
    return () => clearTimeout(t);
  }, [sceneIdx, entered]);

  /* 点击 / 按键 → 动画退场，卡片进场 */
  const enter = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setEntered(true);
    setLeaving(true);
    setTimeout(() => setGone(true), 620);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) enter();
    const onKey = (e: KeyboardEvent) => {
      if (["Enter", " ", "Escape"].includes(e.key)) enter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enter]);

  /* 卡片导航里提供重播入口 */
  const replay = () => {
    leavingRef.current = false;
    setSceneIdx(0);
    setEntered(false);
    setLeaving(false);
    setGone(false);
  };

  /* 卡片光斑跟随指针 */
  const trackSpotlight = (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  /* 普通工具卡（i 决定进场交错时序） */
  const renderCard = (t: (typeof GRID_TOOLS)[number], i: number) => {
    const body = (
      <div className="tool-card-in card">
        <div className="tool-top">
          <span className="tool-glyph">
            <span className="tool-emoji" aria-hidden="true">
              {t.emoji}
            </span>
          </span>
          <ToolStatus label={t.external ? "外部好站！" : undefined} />
        </div>
        <h3 className="tool-title">{t.title}</h3>
        <p className="tool-desc">{t.desc}</p>
        <div className="tool-foot">
          <span className="tool-cta">{t.cta}</span>
          <span className="tool-arrow" aria-hidden="true">
            →
          </span>
        </div>
        <span className="tool-watermark" aria-hidden="true">
          <ToolGlyph name={t.glyph} />
        </span>
      </div>
    );
    const style = { "--i": `${(i + 1) * 70}ms` } as React.CSSProperties;

    return t.external ? (
      <a
        key={t.id}
        href={t.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`tool-card tool-card--${t.id}`}
        style={style}
        onPointerMove={trackSpotlight}
      >
        {body}
      </a>
    ) : (
      <Link
        key={t.id}
        href={t.href}
        className={`tool-card tool-card--${t.id}`}
        style={style}
        onPointerMove={trackSpotlight}
      >
        {body}
      </Link>
    );
  };

  const scene = SCENES[sceneIdx];
  const isFinal = scene?.id === "final";

  return (
    <>
      <Navbar />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "千算Poker BanSolver",
          alternateName: "BanSolver",
          url: "https://bansolver.com",
          inLanguage: "zh-CN",
          description:
            "免费德州扑克工具站：GG 牌谱复盘、翻前 GTO 范围表、胜率与方差计算器，浏览器直接运行，无需注册。",
        }}
      />

      {/* 卡片导航（在动画下层，动画退场时交错浮现） */}
      <main>
        <section className={`home-enter${entered ? " entered" : ""}`}>
          <div className="home-head">
            <span className="home-hero-mark" aria-hidden="true">
              <img src="/brand/qiansuan-mark.svg" alt="" />
            </span>
            <p className="home-kicker">BANSOLVER.COM · POKER TOOLKIT</p>
            <h1 className="home-title">
              千算<span className="text-gold">免费</span>工具站
              <span className="home-title-clause">
                <span className="home-nowrap">帮你找到你的</span>
                <span className="home-nowrap text-gold">核心需求</span>
              </span>
            </h1>
            <p className="home-sub">全部免费 · 无需注册 · 支持电脑手机浏览器</p>
          </div>

          <div className="home-section-head">
            <h2 className="home-section-title">工具箱</h2>
            <span className="home-section-meta">8 个工具 · 全部可用</span>
          </div>

          <div className="tool-grid">
            {/* 主推：数据复盘 */}
            <Link
              href={FEATURED_TOOL.href}
              className="tool-card tool-card--feature"
              style={{ "--i": "0ms" } as React.CSSProperties}
              onPointerMove={trackSpotlight}
              aria-label="打开数据复盘"
            >
              <div className="tool-card-in card">
                <div className="tool-top">
                  <span className="tool-glyph tool-glyph--lg">
                    <span className="tool-emoji" aria-hidden="true">
                      {FEATURED_TOOL.emoji}
                    </span>
                  </span>
                  <ToolStatus />
                </div>
                <div className="feature-copy">
                  <h3 className="tool-title">{FEATURED_TOOL.title}</h3>
                  <p className="tool-desc">{FEATURED_TOOL.desc}</p>
                  <div className="feature-tags">
                    {FEATURED_TOOL.tags?.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="feature-spark" aria-hidden="true">
                  <Sparkline />
                </div>
                <div className="tool-foot">
                  <span className="tool-cta">{FEATURED_TOOL.cta}</span>
                  <span className="tool-arrow" aria-hidden="true">
                    →
                  </span>
                </div>
              </div>
            </Link>

            {/* 主推卡同行：翻后Solver + 翻前范围表 */}
            {TOP_TOOLS.map((t, i) => renderCard(t, i))}

            {/* 第二行：五张工具卡（独立 5 等列子网格） */}
            <div className="tool-grid-row">
              {GRID_TOOLS.map((t, i) => renderCard(t, i + 2))}
            </div>
          </div>

        </section>
      </main>

      <footer className="home-footer">
        <div className="home-footer-inner">
          <p className="home-footer-copy">
            © {new Date().getFullYear()} BanSolver · 梅小板联系微信 muston549 欢迎提建议找bug
            {" · "}
            <Link href="/en">English</Link>
          </p>
          <div className="home-footer-side">
            <p className="home-footer-hint">会员登录可把手牌同步到云端</p>
            <button type="button" className="replay-btn" onClick={replay}>
              ↻ 重播开场动画
            </button>
          </div>
        </div>
      </footer>

      {/* 开场动画（覆盖全屏，点击任意处进入） */}
      {!gone && (
        <div
          className={`intro-overlay${leaving ? " intro-exit" : ""}`}
          onClick={enter}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); enter(); } }}
          role="button"
          tabIndex={0}
          aria-label="跳过动画，进入工具导航"
        >
          <div className="bokeh bokeh-bg" style={{ top: "5%", left: "-8%" }} />
          <div className="bokeh bokeh-mg" style={{ top: "30%", right: "-12%" }} />
          <div className="bokeh bokeh-fg" style={{ bottom: "18%", left: "12%" }} />

          <div className="intro-stage">
            <Scene key={scene?.id} id={scene!.id} />
          </div>

          <div className="intro-dots" aria-hidden="true">
            {SCENES.map((s, i) => (
              <span key={s.id} className={`intro-dot${i === sceneIdx ? " on" : ""}`} />
            ))}
          </div>
          <p className="intro-skip">{isFinal ? "点击任意处进入" : "点击任意处跳过"}</p>
        </div>
      )}
    </>
  );
}
