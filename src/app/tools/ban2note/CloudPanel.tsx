"use client";
// 会员面板：未登录=注册/登录弹窗；已登录=我的手牌库（列表/载入分析/删除/配额/登出）。
// 隐私承诺与产品口径一致：手牌仅用于本人查看，后台不做内容浏览。
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import {
  type MeUser, type CloudFile, type CloudUsage,
  register, login, logout, listHands, downloadHand, deleteHand, renameHand,
  fmtBytes, fmtDate,
} from "./cloud";

type Props = {
  open: boolean;
  onClose: () => void;
  me: MeUser | null;
  onMeChange: (me: MeUser | null) => void;
  /** 载入选中的云端文件重新分析（File[] 交给本地解析主流程） */
  onLoadFiles: (files: File[]) => void;
  /** 解析进行中：禁用载入，防止两条 processFiles 并发交叉写状态 */
  parseLoading: boolean;
};

export default function CloudPanel({ open, onClose, me, onMeChange, onLoadFiles, parseLoading }: Props) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null); // 正在删除的文件 id
  // 多选载入：勾中的文件 id 集合 + 批量下载进度提示
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadProg, setLoadProg] = useState<string | null>(null);
  // 行内改名：renamingId=正在改名的文件 id，renameVal=输入中的新名字
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  useEffect(() => {
    // 每次打开面板都重新拉列表（刚存到云端的文件要立刻出现）；列表拉取很轻
    if (open && me) void refreshList();
    if (!open) { setErr(null); setListErr(null); setSelected(new Set()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, me]);

  const refreshList = useCallback(async () => {
    setListErr(null);
    try {
      const r = await listHands();
      setFiles(r.files);
      setUsage(r.usage);
    } catch (e) {
      setFiles([]);
      setListErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  const submitAuth = async () => {
    setBusy(true); setErr(null);
    try {
      const u = tab === "login" ? await login(name.trim(), pass) : await register(name.trim(), pass);
      onMeChange(u);
      setName(""); setPass("");
      await refreshList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失败");
    } finally { setBusy(false); }
  };

  const doLogout = async () => {
    try { await logout(); } catch { /* 忽略 */ }
    onMeChange(null);
    setFiles(null); setUsage(null); setName(""); setPass("");
  };

  // 批量载入选中文件：逐个下载 → 包装成 File[] → 交给本地解析主流程（解析永远在本地）
  const doLoadSelected = async () => {
    if (!files || selected.size === 0 || loadProg || parseLoading) return;
    const picks = files.filter((f) => selected.has(f.id));
    setListErr(null);
    try {
      const out: File[] = [];
      for (let i = 0; i < picks.length; i++) {
        setLoadProg(`下载中 ${i + 1}/${picks.length}…`);
        const text = await downloadHand(picks[i].id, picks[i].name);
        out.push(new File([text], picks[i].name, { type: "text/plain" }));
      }
      setLoadProg(null);
      onLoadFiles(out);
      setSelected(new Set());
      onClose();
    } catch (e) {
      setLoadProg(null);
      setListErr(e instanceof Error ? e.message : "载入失败");
    }
  };

  const toggleSel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doRename = async (f: CloudFile) => {
    const name = renameVal.trim();
    if (!name || name === f.name) { setRenamingId(null); return; }
    setListErr(null);
    try {
      await renameHand(f.id, name);
      setRenamingId(null);
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "改名失败");
    }
  };

  const doDelete = async (f: CloudFile) => {
    if (!confirm(`删除「${f.name}」（${f.hands.toLocaleString()} 手）？此操作不可恢复。`)) return;
    setActing(f.id); setListErr(null);
    try {
      await deleteHand(f.id);
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "删除失败");
    } finally { setActing(null); }
  };

  if (!open) return null;

  return (
    <div className="b2rp-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="b2rp-panel b2c-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="会员中心">
        <div className="b2rp-head">
          <span className="b2rp-title">{me ? "我的手牌库" : "登录 / 注册"}</span>
          <button type="button" className="ban2-share-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        {!me ? (
          <div className="b2c-auth">
            <div className="b2c-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "login"}
                className={`b2c-tab ${tab === "login" ? "b2c-tab--on" : ""}`} onClick={() => { setTab("login"); setErr(null); }}>登录</button>
              <button type="button" role="tab" aria-selected={tab === "register"}
                className={`b2c-tab ${tab === "register" ? "b2c-tab--on" : ""}`} onClick={() => { setTab("register"); setErr(null); }}>注册</button>
            </div>
            <label className="b2c-field">
              <span>用户名</span>
              <input className="b2c-input" value={name} autoComplete="username"
                placeholder="2-24 位，字母 / 数字 / 下划线（不支持中文）"
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="b2c-field">
              <span>密码</span>
              <input className="b2c-input" type="password" value={pass}
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                placeholder="至少 6 位"
                onKeyDown={(e) => { if (e.key === "Enter" && !busy) void submitAuth(); }}
                onChange={(e) => setPass(e.target.value)} />
            </label>
            {err && <div className="b2c-err" role="alert">{err}</div>}
            <button type="button" className="b2c-primary" disabled={busy || !name || !pass} onClick={submitAuth}>
              {busy ? "请稍候…" : tab === "login" ? "登录" : "注册并登录"}
            </button>
            <p className="b2c-note">
              {tab === "register"
                ? "注册后支持手牌多设备同步，忘记密码联系站长梅小板微信 muston549 找回。"
                : "忘记密码联系站长梅小板微信 muston549 找回。"}
            </p>
          </div>
        ) : (
          <div className="b2c-lib">
            <div className="b2c-lib-top">
              <span className="b2c-user">👤 {me.username}</span>
              <button type="button" className="b2c-ghost" onClick={doLogout}>退出登录</button>
            </div>

            {usage && (
              <div className="b2c-quota">
                已存 {usage.hands.toLocaleString()} / {usage.quotaHands.toLocaleString()} 手 · {fmtBytes(usage.bytes)} / {fmtBytes(usage.quotaBytes)}
                <span className="b2c-quota-bar">
                  <span style={{ width: `${Math.min(100, Math.max(usage.bytes / usage.quotaBytes, usage.hands / usage.quotaHands) * 100).toFixed(1)}%` }} />
                </span>
              </div>
            )}

            {listErr && <div className="b2c-err" role="alert">{listErr}</div>}
            {files === null && <div className="b2c-empty">加载中…</div>}
            {files !== null && files.length === 0 && (
              <div className="b2c-empty">还没有云端文件。解析完手牌后点「存到云端」即可。</div>
            )}
            {files !== null && files.length > 0 && (
              <ul className="b2c-list">
                {files.map((f) => (
                  <li key={f.id} className={`b2c-item${selected.has(f.id) ? " b2c-item--sel" : ""}`}>
                    {renamingId === f.id ? (
                      // 行内改名态
                      <div className="b2c-rename">
                        <input
                          className="b2c-input b2c-rename-input"
                          value={renameVal}
                          autoFocus
                          maxLength={60}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void doRename(f);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                        />
                        <button type="button" className="b2c-ghost" onClick={() => doRename(f)}>保存</button>
                        <button type="button" className="b2c-ghost" onClick={() => setRenamingId(null)}>取消</button>
                      </div>
                    ) : (
                      <>
                        <label className="b2c-item-pick">
                          <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleSel(f.id)} />
                          <span className="b2c-item-info">
                            <span className="b2c-item-name">{f.name}</span>
                            <span className="b2c-item-meta">
                              {f.hands.toLocaleString()} 手 · {fmtBytes(f.bytes)} · {fmtDate(f.createdAt)}
                            </span>
                          </span>
                        </label>
                        <div className="b2c-item-actions">
                          <button type="button" className="b2c-ghost" onClick={() => { setRenamingId(f.id); setRenameVal(f.name); }}>改名</button>
                          <button type="button" className="b2c-ghost b2c-ghost--danger" disabled={acting === f.id} onClick={() => doDelete(f)}>删除</button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {files !== null && files.length > 0 && (
              <div className="b2c-loadbar">
                <button type="button" className="b2c-ghost" onClick={() => setSelected(selected.size === files.length ? new Set() : new Set(files.map((f) => f.id)))}>
                  {selected.size === files.length ? "清空勾选" : "全选"}
                </button>
                <button type="button" className="b2c-primary b2c-loadbtn" disabled={selected.size === 0 || !!loadProg || parseLoading} onClick={doLoadSelected}>
                  {loadProg ?? (parseLoading ? "解析进行中…" : selected.size > 0 ? `载入选中（${selected.size} 个文件）` : "勾选要载入的文件")}
                </button>
              </div>
            )}
            <p className="b2c-note">
              <Link href="/member" className="b2c-memlink">
                会员中心 →
              </Link>
            </p>
            <p className="b2c-note">当前本站完全免费 服务器配置较低 暂时只支持少量手牌云存储 感谢理解</p>
          </div>
        )}
      </div>
    </div>
  );
}
