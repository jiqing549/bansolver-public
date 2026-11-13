"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import ToolGlyph from "./ToolGlyph";
import { SOLVER_URL, type Tool } from "./tools";
import { CORE_NAV_TOOLS, MEGA_CATEGORIES } from "./navMega";
import { fetchMe, type MeUser } from "../tools/ban2note/cloud";

export { SOLVER_URL };

/* ==============================================
   翻后Solver：每日首次点击弹介绍，之后直接跳
   ============================================== */
const SOLVER_SEEN_KEY = "bs_solver_intro_seen";

function todayStr() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function solverJump() {
  window.open(SOLVER_URL, "_blank", "noopener,noreferrer");
}

/* ==============================================
   小图标
   ============================================== */
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* ==============================================
   Navbar
   ============================================== */
export default function Navbar() {
  const pathname = usePathname() || "";
  const router = useRouter();

  const [showDeals, setShowDeals] = useState(false);
  const [showSolver, setShowSolver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [megaOpen, setMegaOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  /* ---- 会员登录态：路由变化重拉 + 监听 ban2note 页广播的 bs-me 事件 ---- */
  const [me, setMe] = useState<MeUser | null>(null);

  /* ---- 每日一次 Solver 介绍 ---- */
  const onSolverClick = useCallback(() => {
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(SOLVER_SEEN_KEY);
    } catch {
      /* 隐私模式读不到：每次都弹 */
    }
    if (seen === todayStr()) {
      solverJump();
      return;
    }
    try {
      window.localStorage.setItem(SOLVER_SEEN_KEY, todayStr());
    } catch {
      /* 写不进也不拦弹窗 */
    }
    setShowSolver(true);
  }, []);

  const onSolverGo = () => {
    solverJump();
    setShowSolver(false);
  };

  /* ---- 滚动状态：顶栏加深 ---- */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* ---- 路由切换时收起浮层（导航属于外部事件，需同步 UI 状态）---- */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMenuOpen(false);
    setMegaOpen(false);
  }, [pathname]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ---- 会员登录态：进页/路由变化拉一次；登录登出时 ban2note 会广播 bs-me ---- */
  useEffect(() => { void fetchMe().then(setMe); }, [pathname]);
  useEffect(() => {
    const onMe = (e: Event) => setMe((e as CustomEvent).detail ?? null);
    window.addEventListener("bs-me", onMe);
    return () => window.removeEventListener("bs-me", onMe);
  }, []);

  /* ---- 会员按钮：已登录一律去会员中心（手牌库走页内按钮或会员中心入口）；未登录 ban2note 页内直接开弹窗，其他页跳过去带 cloud=1 ---- */
  const onCloudClick = useCallback(() => {
    if (me) {
      router.push("/member");
    } else if (pathname?.startsWith("/tools/ban2note")) {
      window.dispatchEvent(new CustomEvent("bs-open-cloud"));
    } else {
      router.push("/tools/ban2note?cloud=1");
    }
  }, [pathname, router, me]);

  /* ---- 键盘：Esc 关闭浮层 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowDeals(false);
        setShowSolver(false);
        setMenuOpen(false);
        setMegaOpen(false);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- 浮层打开时锁滚动 ---- */
  useEffect(() => {
    if (!(menuOpen || megaOpen || showDeals || showSolver)) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen, megaOpen, showDeals, showSolver]);

  /* ---- Mega：点外部关闭；窄屏自动收起（避免状态残留锁滚动）---- */
  useEffect(() => {
    if (!megaOpen) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest(".nav-mega, .nav-mega-trigger")) setMegaOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [megaOpen]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 1100) setMegaOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const megaBadge = (t: Tool) => {
    if (t.id === "ban2note") {
      return <span className="nav-mega-badge nav-mega-badge--feature">主推</span>;
    }
    if (t.id === "squid") {
      return <span className="nav-mega-badge nav-mega-badge--soon">内测中</span>;
    }
    if (t.id === "pftrain") {
      return <span className="nav-mega-badge">NEW</span>;
    }
    if (t.external) {
      return <span className="nav-mega-badge nav-mega-badge--ext">外站 ↗</span>;
    }
    return null;
  };

  const renderDrawerItem = (t: Tool) => {
    const active = pathname === t.href || pathname.startsWith(t.href + "/");
    const soon = t.id === "squid";
    const content = (
      <>
        <span className="nav-drawer-glyph">
          <ToolGlyph name={t.glyph} />
        </span>
        <span className="nav-drawer-copy">
          <b>{t.title}</b>
          <i>{t.short}</i>
        </span>
        {soon ? (
          <span className="nav-drawer-soon">内测中</span>
        ) : (
          <span className="nav-drawer-arrow" aria-hidden="true">
            →
          </span>
        )}
      </>
    );
    if (soon) {
      return (
        <button
          key={t.id}
          type="button"
          className="nav-drawer-item nav-drawer-item--button nav-drawer-item--soon"
          disabled
          aria-disabled="true"
        >
          {content}
        </button>
      );
    }
    if (t.id === "solver") {
      return (
        <button
          key={t.id}
          type="button"
          className="nav-drawer-item nav-drawer-item--button"
          onClick={() => {
            setMenuOpen(false);
            onSolverClick();
          }}
        >
          {content}
        </button>
      );
    }
    return (
      <Link
        key={t.id}
        href={t.href}
        className={`nav-drawer-item${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={() => setMenuOpen(false)}
      >
        {content}
      </Link>
    );
  };

  return (
    <>
      <nav className={`navbar${scrolled ? " navbar--scrolled" : ""}`}>
        <div className="navbar-inner">
          <Link href="/" className="navbar-brand" aria-label="千算Poker 首页">
            <span className="navbar-mark" aria-hidden="true">
              <img src="/brand/qiansuan-mark.svg" alt="" />
            </span>
            <span className="navbar-brand-text">
              <span className="navbar-brand-main">千算Poker免费工具站</span>
              <span className="navbar-brand-sub">BanSolver.com</span>
            </span>
          </Link>

          <div className="navbar-links">
            {CORE_NAV_TOOLS.map((l) => {
              const active =
                pathname === l.href || pathname.startsWith(l.href + "/");
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`navbar-link navbar-link--gold${active ? " navbar-link--active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  {l.title}
                </Link>
              );
            })}

            <button
              type="button"
              className="navbar-link navbar-link--solver"
              onClick={onSolverClick}
            >
              翻后Solver
            </button>

            <button
              type="button"
              className={`navbar-link nav-mega-trigger${megaOpen ? " is-open" : ""}`}
              onClick={() => setMegaOpen((v) => !v)}
              aria-haspopup="true"
              aria-expanded={megaOpen}
              aria-controls="nav-mega"
            >
              <svg
                className="nav-mega-grid"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
              </svg>
              全部工具
              <span className="nav-mega-chev" aria-hidden="true">▾</span>
            </button>

            {/* 站长后台入口：仅白名单用户可见（真鉴权在 /api/admin/*） */}
            {me?.isAdmin ? (
              <Link href="/admin" className="navbar-link navbar-link--gold">
                后台
              </Link>
            ) : null}

            <button
              type="button"
              className="navbar-search navbar-cloud"
              onClick={onCloudClick}
              aria-label={me ? `已登录：${me.username}，打开会员中心` : "会员登录"}
              title={me ? "会员中心" : "会员登录"}
            >
              <span className="navbar-cloud-icon" aria-hidden="true">☁</span>
              <span className="navbar-cloud-name">{me ? me.username : "会员登录"}</span>
            </button>
          </div>

          <div className="navbar-mobile-actions">
            <button
              type="button"
              className="navbar-icon-btn"
              onClick={onCloudClick}
              aria-label={me ? `已登录：${me.username}，打开会员中心` : "会员登录"}
            >
              ☁
            </button>
            <button
              type="button"
              className={`nav-burger${menuOpen ? " is-open" : ""}`}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
              aria-expanded={menuOpen}
              aria-controls="nav-drawer"
            >
              <span />
              <span />
            </button>
          </div>
        </div>

        {megaOpen && (
          <div
            className="nav-mega"
            id="nav-mega"
            role="dialog"
            aria-modal="true"
            aria-label="全部工具"
          >
            <div className="nav-mega-inner">
              <button
                type="button"
                className="nav-mega-close"
                onClick={() => setMegaOpen(false)}
                aria-label="关闭全部工具"
              >
                <CloseIcon />
              </button>

              <div className="nav-mega-cats">
                {MEGA_CATEGORIES.map((cat) => (
                  <section
                    key={cat.id}
                    className="nav-mega-cat"
                    aria-labelledby={`nav-mega-cat-${cat.id}`}
                  >
                    <div className="nav-mega-cat-head">
                      <span className="nav-mega-cat-num">{cat.num}</span>
                      <div>
                        <h3 id={`nav-mega-cat-${cat.id}`}>{cat.title}</h3>
                        <em>{cat.en}</em>
                      </div>
                      <span className="nav-mega-cat-count">{cat.tools.length}</span>
                    </div>
                    <p className="nav-mega-cat-desc">{cat.desc}</p>
                    <div className="nav-mega-cat-list">
                      {cat.tools.map((t) => {
                        const content = (
                          <>
                            <span className="nav-mega-row-glyph">
                              <ToolGlyph name={t.glyph} />
                            </span>
                            <span className="nav-mega-row-copy">
                              <b>{t.title}</b>
                              <i>{t.short}</i>
                            </span>
                            {megaBadge(t)}
                          </>
                        );
                        return t.id === "solver" ? (
                          <button
                            key={t.id}
                            type="button"
                            className="nav-mega-row nav-mega-row--button"
                            onClick={() => {
                              setMegaOpen(false);
                              onSolverClick();
                            }}
                          >
                            {content}
                          </button>
                        ) : t.id === "squid" ? (
                          <button
                            key={t.id}
                            type="button"
                            className="nav-mega-row nav-mega-row--button nav-mega-row--soon"
                            disabled
                            aria-disabled="true"
                          >
                            {content}
                          </button>
                        ) : (
                          <Link
                            key={t.id}
                            href={t.href}
                            className="nav-mega-row"
                            onClick={() => setMegaOpen(false)}
                          >
                            {content}
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>

              <div className="nav-mega-foot">
                <button
                  type="button"
                  className="nav-mega-ad"
                  onClick={() => {
                    setMegaOpen(false);
                    setShowDeals(true);
                  }}
                >
                  广告位招租 →
                </button>
                <span>
                  <kbd>esc</kbd> 关闭
                </span>
              </div>
            </div>
          </div>
        )}
      </nav>

      {megaOpen && (
        <div
          className="nav-mega-veil"
          onClick={() => setMegaOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ---- 移动端抽屉 ---- */}
      {menuOpen && (
        <div
          className="nav-drawer-overlay"
          onClick={() => setMenuOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="工具导航"
        >
          <div
            className="nav-drawer"
            id="nav-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nav-drawer-head">
              <span className="nav-drawer-title">工具导航</span>
              <button
                type="button"
                className="nav-drawer-close"
                onClick={() => setMenuOpen(false)}
                aria-label="关闭菜单"
                autoFocus
              >
                <CloseIcon />
              </button>
            </div>

            <nav className="nav-drawer-list">
              {MEGA_CATEGORIES.map((cat) => (
                <div className="nav-drawer-group" key={cat.id}>
                  <h4>
                    <span>
                      {cat.num} {cat.title}
                    </span>
                    <em>{cat.en}</em>
                  </h4>
                  {cat.tools.map(renderDrawerItem)}
                </div>
              ))}
            </nav>

            <div className="nav-drawer-actions">
              <button
                type="button"
                className="nav-drawer-action"
                onClick={() => {
                  setMenuOpen(false);
                  setShowDeals(true);
                }}
              >
                广告位招租
              </button>
            </div>

            <p className="nav-drawer-note">全部免费 · 无需注册 · 浏览器直接跑</p>
          </div>
        </div>
      )}

      {/* ---- 广告位招租 ---- */}
      {showDeals && (
        <div
          className="navbar-contact-overlay"
          onClick={() => setShowDeals(false)}
          role="dialog"
          aria-modal="true"
          aria-label="广告位招租"
        >
          <div
            className="navbar-contact-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="navbar-contact-close"
              onClick={() => setShowDeals(false)}
              aria-label="关闭"
            >
              <CloseIcon />
            </button>
            <h2 className="navbar-contact-title">广告位招租</h2>
            <div className="navbar-contact-empty" aria-hidden="true" />
          </div>
        </div>
      )}

      {/* ---- 翻后Solver 介绍 ---- */}
      {showSolver && (
        <div
          className="navbar-solver-overlay"
          onClick={() => setShowSolver(false)}
          role="dialog"
          aria-modal="true"
          aria-label="翻后Solver 介绍"
        >
          <div
            className="navbar-solver-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="navbar-solver-close"
              onClick={() => setShowSolver(false)}
              aria-label="关闭"
            >
              <CloseIcon />
            </button>
            <h2 className="navbar-solver-title">翻后Solver</h2>
            <p className="navbar-solver-src">zenosolver.com by Oleg Ostroumov</p>
            <p className="navbar-solver-lead">
              你好！我是千算Poker梅小板
              <br />
              向你分享我发现的超快速GTO求解器：ZenoSolver
              <br />
              轻量求解查询可平替GTOWizard
              <br />
              不过beta阶段仍有不少bug 暂不推荐深度科研
              <br />
              B站up@梦才MornTsuy 在征集伙伴debug和汉化
              <br />
              如果想帮忙欢迎私信梦才或者在粉丝群联系梅小板
              <br />
              我们一起为国内德扑学习出一份力！
            </p>
            <p className="navbar-solver-sign">
              本站将免费为大家开发、收集真正好用的妙妙工具
              <br />
              希望你收藏本站，持续使用就是对我最大的支持
              <br />
              学扑克，找千算！开始使用吧！
            </p>
            <button type="button" className="navbar-solver-go" onClick={onSolverGo}>
              前往 Zeno Solver ↗
            </button>
            <p className="navbar-solver-hint">今日内再次点击按钮将直接跳转</p>
          </div>
        </div>
      )}
    </>
  );
}

