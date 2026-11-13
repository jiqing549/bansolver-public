// 会员云端存储客户端（纯逻辑层，UI 无关）。
// 红线：上传的是手牌原文的 gzip 字节，云端不解不析；解析永远在本地。

export type MeUser = {
  id: number;
  username: string;
  createdAt?: number;
  /** 站长白名单命中（ADMIN_USERNAMES）：顶栏显隐「后台」入口；真鉴权在 /api/admin/* */
  isAdmin?: boolean;
};

export type CloudFile = {
  id: string;
  name: string;
  hands: number;
  bytes: number;
  createdAt: number;
};

export type CloudUsage = { bytes: number; hands: number; quotaBytes: number; quotaHands: number };

type ApiError = { ok: false; error: string };

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, opts);
  const j = (await r.json().catch(() => null)) as (T & { ok?: boolean }) | ApiError | null;
  if (!r.ok || !j || (j as ApiError).ok === false) {
    throw new Error((j as ApiError)?.error ?? "网络异常，稍后再试");
  }
  return j as T;
}

// ---------- 认证 ----------
export function fetchMe(): Promise<MeUser | null> {
  // auth 挂了不挡前端：失败当未登录
  return fetch("/api/auth/me")
    .then((r) => r.json())
    .then((j) => (j?.user ?? null) as MeUser | null)
    .catch(() => null);
}

export function register(username: string, password: string): Promise<MeUser> {
  return api<{ ok: true; user: MeUser }>("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then((j) => j.user);
}

export function login(username: string, password: string): Promise<MeUser> {
  return api<{ ok: true; user: MeUser }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then((j) => j.user);
}

export function logout(): Promise<void> {
  return fetch("/api/auth/logout", { method: "POST" }).then(() => undefined);
}

// ---------- gzip（浏览器 CompressionStream）----------
export function canGzip(): boolean {
  return typeof CompressionStream !== "undefined";
}

async function gzipBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// ---------- 手牌库 ----------
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadHands(
  text: string,
  name: string,
  hands: number,
): Promise<{ id: string; bytes: number; deduped?: boolean; existingName?: string }> {
  const headers: Record<string, string> = {
    "X-BS-Name": encodeURIComponent(name),
    "X-BS-Hands": String(hands),
    // 内容指纹（原文 sha256）：服务端据此做内容级去重，完全相同直接跳过
    "X-BS-Hash": await sha256Hex(text),
  };
  if (canGzip()) {
    headers["X-BS-Encoding"] = "gzip";
    headers["Content-Type"] = "application/octet-stream";
    const gz = await gzipBytes(text);
    // TS 5.7+ 把 Uint8Array 泛型收窄成 ArrayBufferLike，DOM BodyInit 只认
    // ArrayBufferBacked 的精确变体；运行时 fetch 直接收 Uint8Array，拷到新
    // ArrayBuffer 即同时满足两边的类型与运行时
    const body = new Uint8Array(gz).slice().buffer;
    return api("/api/hands/upload", { method: "POST", headers, body });
  }
  // 老浏览器兜底：发原文，服务端压缩
  headers["Content-Type"] = "text/plain";
  return api("/api/hands/upload", { method: "POST", headers, body: text });
}

export function renameHand(id: string, name: string): Promise<void> {
  return api("/api/hands/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  }).then(() => undefined);
}

export function listHands(): Promise<{ files: CloudFile[]; usage: CloudUsage }> {
  return api<{ ok: true; files: CloudFile[]; usage: CloudUsage }>("/api/hands/list");
}

export async function downloadHand(id: string, name: string): Promise<string> {
  const r = await fetch(`/api/hands/download?id=${encodeURIComponent(id)}`);
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error((j as ApiError)?.error ?? "下载失败");
  }
  const buf = await r.arrayBuffer();
  if (canGzip()) return gunzipText(buf);
  // 理论上能走到这的浏览器也能 DecompressionStream；兜底提示换现代浏览器
  throw new Error("当前浏览器过旧，无法解压云端文件，请换 Chrome / Edge / Safari 新版");
}

export function deleteHand(id: string): Promise<void> {
  return api("/api/hands/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }).then(() => undefined);
}

// ---------- 展示辅助 ----------
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
