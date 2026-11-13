// 番茄钟会员云历史客户端（纯逻辑层，UI 无关）。
// 每次「结束本次」自动存一条复盘；逐块明细（含一句话手感）在 blocksData。
// 登录态复用全站会员系统：fetchMe / bs-me 广播与顶栏同源。
import { fetchMe, type MeUser } from "@/app/tools/ban2note/cloud";
import type { BlockEntry, FeelLevel } from "@/lib/pomodoro";

export type { MeUser };
export { fetchMe };

export type PomoRecord = {
  id: string;
  startedAt: number;
  endedAt: number;
  blocks: number;
  focusMin: number;
  elapsedSec: number;
  avgTilt: number | null;
  reason: string;
  feelCounts: Partial<Record<FeelLevel, number>>;
  blocksData: BlockEntry[];
};

export type PomoRecordInput = Omit<PomoRecord, "id">;

type ApiError = { ok: false; error: string };

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, opts);
  const j = (await r.json().catch(() => null)) as (T & { ok?: boolean }) | ApiError | null;
  if (!r.ok || !j || (j as ApiError).ok === false) {
    throw new Error((j as ApiError)?.error ?? "网络异常，稍后再试");
  }
  return j as T;
}

export function saveRecord(rec: PomoRecordInput): Promise<string> {
  return api<{ ok: true; id: string }>("/api/pomodoro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rec),
  }).then((j) => j.id);
}

export async function listRecords(): Promise<PomoRecord[]> {
  const j = await api<{ ok: true; sessions: unknown[] }>("/api/pomodoro");
  return (j.sessions ?? []).map((raw) => {
    const r = raw as Partial<PomoRecord> & { feelCounts?: unknown };
    return {
      id: String(r.id ?? ""),
      startedAt: Number(r.startedAt) || 0,
      endedAt: Number(r.endedAt) || 0,
      blocks: Number(r.blocks) || 0,
      focusMin: Number(r.focusMin) || 0,
      elapsedSec: Number(r.elapsedSec) || 0,
      avgTilt: typeof r.avgTilt === "number" ? r.avgTilt : null,
      reason: typeof r.reason === "string" ? r.reason : "",
      feelCounts: (r.feelCounts && typeof r.feelCounts === "object" ? r.feelCounts : {}) as PomoRecord["feelCounts"],
      blocksData: Array.isArray(r.blocksData) ? (r.blocksData as BlockEntry[]) : [],
    };
  });
}

export async function deleteRecord(id: string): Promise<void> {
  await api(`/api/pomodoro?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
