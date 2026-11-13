"use client";
// 会员中心 /member：每个登录会员都能进的账号主页。
// 账号信息 / 云存储用量与配额 / 云手牌库·番茄钟复盘入口 / 改密码 / 在线设备管理 / 退出登录。
// 隐私口径不变：页面上只有元数据（数量/字节），没有任何手牌内容。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import ToolHeader from "@/app/components/ToolHeader";
import SiteFooter from "@/app/components/SiteFooter";
import { fetchMe, logout, type MeUser } from "../tools/ban2note/cloud";
import "./member.css";

type Summary = {
  ok: true;
  user: { username: string; createdAt: number } | null;
  usage: {
    files: number;
    hands: number;
    bytes: number;
    quotaHands: number;
    quotaBytes: number;
  };
  pomoCount: number;
  deviceCount: number;
  lastSeen: number;
};
type SessionRow = {
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  current: boolean;
};

function fmtBytes(n: number) {
  if (!n) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtNum(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n);
}
function fmtDate(ts: number) {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtAgo(ts: number) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} 天前`;
  return fmtDate(ts);
}

type Gate = "checking" | "login" | "ready";

export default function MemberPage() {
  const [gate, setGate] = useState<Gate>("checking");
  const [me, setMe] = useState<MeUser | null>(null);
  const [data, setData] = useState<Summary | null>(null);
  const [devices, setDevices] = useState<SessionRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // 改密码表单
  const [cur, setCur] = useState("");
  const [nw, setNw] = useState("");
  const [nw2, setNw2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [revokeBusy, setRevokeBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);

  // 进门：登录态（未登录 3 秒轮询一次，别的标签页登录后自动进场）
  useEffect(() => {
    void (async () => {
      const m = await fetchMe();
      setMe(m);
      setGate(m ? "ready" : "login");
    })();
  }, []);
  useEffect(() => {
    if (gate !== "login") return;
    const t = setInterval(async () => {
      const m = await fetchMe();
      if (m) {
        setMe(m);
        setGate("ready");
      }
    }, 3000);
    return () => clearInterval(t);
  }, [gate]);

  const refresh = useCallback(async () => {
    setLoadErr(null);
    try {
      const [a, b] = await Promise.all([
        fetch("/api/member/summary").then((r) => r.json()),
        fetch("/api/auth/sessions").then((r) => r.json()),
      ]);
      if (!a?.ok) throw new Error(a?.error ?? "加载失败");
      if (!b?.ok) throw new Error(b?.error ?? "加载失败");
      setData(a);
      setDevices(b.sessions);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    if (gate === "ready") void refresh();
  }, [gate, refresh]);

  // 改密码：成功后其他设备下线，本机保持登录
  const changePw = useCallback(async () => {
    if (pwBusy) return;
    setPwMsg(null);
    if (!cur || !nw || !nw2) {
      setPwMsg({ ok: false, text: "三项都要填" });
      return;
    }
    if (nw !== nw2) {
      setPwMsg({ ok: false, text: "两次输入的新密码不一致" });
      return;
    }
    setPwBusy(true);
    try {
      const r = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: cur, next: nw }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error ?? "修改失败");
      setPwMsg({ ok: true, text: "密码已更新，其他设备已全部下线" });
      setCur("");
      setNw("");
      setNw2("");
      void refresh();
    } catch (e) {
      setPwMsg({ ok: false, text: e instanceof Error ? e.message : "修改失败" });
    } finally {
      setPwBusy(false);
    }
  }, [cur, nw, nw2, pwBusy, refresh]);

  // 下线其他设备（二次确认，4 秒不点自动还原）
  const revokeOthers = useCallback(async () => {
    if (revokeBusy) return;
    setRevokeBusy(true);
    try {
      const r = await fetch("/api/auth/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke-others" }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error ?? "操作失败");
      setConfirmRevoke(false);
      void refresh();
    } catch {
      setConfirmRevoke(false);
    } finally {
      setRevokeBusy(false);
    }
  }, [revokeBusy, refresh]);

  const doLogout = useCallback(async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await logout();
    } catch {
      /* 忽略 */
    }
    setMe(null);
    setGate("login");
    setLogoutBusy(false);
  }, [logoutBusy]);

  return (
    <>
      <Navbar />
      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner" style={{ maxWidth: "1080px" }}>
          <ToolHeader
            kicker="会员 / 我的中心"
            title="会员中心"
            glyph="member"
            backLabel="← 返回站点"
            backHref="/"
          />

          {gate === "checking" && <p className="mem-loading">验证身份中…</p>}

          {gate === "login" && (
            <div className="card mem-gate">
              <p>请先登录。登录完成会自动回到本页。</p>
              <Link href="/tools/ban2note?cloud=1&back=/member" className="mem-gate-btn">
                去登录
              </Link>
            </div>
          )}

          {gate === "ready" && (
            <div className="mem-wrap">
              <div className="mem-topline">
                <span className="mem-sub">
                  云端只当网盘：手牌仅用于你本人查看，存储内容不做人工浏览。
                </span>
                <button
                  type="button"
                  className="mem-btn mem-btn--ghost"
                  onClick={() => void doLogout()}
                  disabled={logoutBusy}
                >
                  {logoutBusy ? "退出中…" : "退出登录"}
                </button>
              </div>

              {loadErr && <div className="mem-msg mem-msg--err">{loadErr}</div>}
              {data === null && !loadErr && <p className="mem-loading">加载中…</p>}

              {data && (
                <>
                  {/* 三卡：账号 / 云存储 / 番茄钟 */}
                  <div className="mem-grid">
                    <div className="mem-card">
                      <div className="mem-card-label">我的账号</div>
                      <div className="mem-name">
                        {data.user?.username ?? me?.username}
                        <span className="mem-badge">会员</span>
                      </div>
                      <div className="mem-sub">
                        注册于 {data.user ? fmtDate(data.user.createdAt) : "—"}
                        {data.user
                          ? ` · 已陪伴 ${Math.max(
                              1,
                              Math.ceil((Date.now() - data.user.createdAt) / 86400_000),
                            )} 天`
                          : ""}
                      </div>
                    </div>

                    <div className="mem-card">
                      <div className="mem-card-label">云存储用量</div>
                      <div className="mem-num">
                        {fmtNum(data.usage.hands)}
                        <span className="mem-num-unit"> / {fmtNum(data.usage.quotaHands)} 手</span>
                      </div>
                      <div className="mem-meter">
                        <div className="mem-meter-head">
                          <span>手数配额</span>
                          <b>{Math.min(100, Math.round((data.usage.hands / data.usage.quotaHands) * 100))}%</b>
                        </div>
                        <span className="mem-track">
                          <span
                            className="mem-fill"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.max(1, Math.round((data.usage.hands / data.usage.quotaHands) * 100)),
                              )}%`,
                            }}
                          />
                        </span>
                      </div>
                      <div className="mem-meter">
                        <div className="mem-meter-head">
                          <span>
                            存储 <b>{fmtBytes(data.usage.bytes)}</b> / 100 MB
                          </span>
                          <b>
                            {Math.min(100, Math.round((data.usage.bytes / data.usage.quotaBytes) * 100))}%
                          </b>
                        </div>
                        <span className="mem-track">
                          <span
                            className="mem-fill"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.max(1, Math.round((data.usage.bytes / data.usage.quotaBytes) * 100)),
                              )}%`,
                            }}
                          />
                        </span>
                      </div>
                      <div className="mem-sub">
                        云端文件 {data.usage.files} 个
                      </div>
                      <div className="mem-card-actions">
                        <Link href="/tools/ban2note?cloud=1" className="mem-btn">
                          我的云手牌库 →
                        </Link>
                      </div>
                    </div>

                    <div className="mem-card">
                      <div className="mem-card-label">番茄钟复盘</div>
                      <div className="mem-num">
                        {data.pomoCount}
                        <span className="mem-num-unit"> 次收工复盘</span>
                      </div>
                      <div className="mem-sub">每块记一句手感，收工自动存云端。</div>
                      <div className="mem-card-actions">
                        <Link href="/tools/pomodoro" className="mem-btn">
                          去复盘 →
                        </Link>
                      </div>
                    </div>
                  </div>

                  {/* 安全：改密码 + 设备 */}
                  <div className="mem-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <div className="mem-card">
                      <div className="mem-card-label">修改密码</div>
                      <div className="mem-form">
                        <input
                          className="mem-input"
                          type="password"
                          value={cur}
                          onChange={(e) => setCur(e.target.value)}
                          placeholder="当前密码"
                          autoComplete="current-password"
                        />
                        <input
                          className="mem-input"
                          type="password"
                          value={nw}
                          onChange={(e) => setNw(e.target.value)}
                          placeholder="新密码（至少 6 位）"
                          autoComplete="new-password"
                        />
                        <input
                          className="mem-input"
                          type="password"
                          value={nw2}
                          onChange={(e) => setNw2(e.target.value)}
                          placeholder="再输一遍新密码"
                          autoComplete="new-password"
                        />
                        <button
                          type="button"
                          className="mem-btn"
                          onClick={() => void changePw()}
                          disabled={pwBusy}
                          style={{ alignSelf: "flex-start" }}
                        >
                          {pwBusy ? "提交中…" : "更新密码"}
                        </button>
                        {pwMsg && (
                          <div className={`mem-msg ${pwMsg.ok ? "mem-msg--ok" : "mem-msg--err"}`}>
                            {pwMsg.text}
                          </div>
                        )}
                      </div>
                      <p className="mem-hint">
                        改密码后其他设备会全部下线，本机保持登录。忘记密码联系站长梅小板微信
                        muston549 找回。
                      </p>
                    </div>

                    <div className="mem-card">
                      <div className="mem-card-label">
                        在线设备（{data.deviceCount} 台活跃会话）
                      </div>
                      <div className="mem-devices">
                        {(devices ?? []).slice(0, 8).map((s, i) => (
                          <div key={i} className="mem-dev">
                            <span>
                              {s.current ? <b>本机</b> : "其他设备"} · 活跃{" "}
                              {fmtAgo(s.lastSeen)}
                            </span>
                            {s.current && <span className="mem-dev-now">当前</span>}
                          </div>
                        ))}
                      </div>
                      <div className="mem-card-actions">
                        <button
                          type="button"
                          className={`mem-btn ${confirmRevoke ? "mem-btn--danger" : "mem-btn--ghost"}`}
                          disabled={revokeBusy || data.deviceCount <= 1}
                          onClick={() => {
                            if (confirmRevoke) void revokeOthers();
                            else {
                              setConfirmRevoke(true);
                              setTimeout(() => setConfirmRevoke(false), 4000);
                            }
                          }}
                        >
                          {revokeBusy
                            ? "执行中…"
                            : confirmRevoke
                              ? "确认下线其他设备？"
                              : data.deviceCount <= 1
                                ? "没有其他设备"
                                : "下线其他设备"}
                        </button>
                      </div>
                      <p className="mem-hint">
                        在别人的电脑上登录过？点这里把它踢下线。本机不受影响。
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <SiteFooter />
    </>
  );
}
