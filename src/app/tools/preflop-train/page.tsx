"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import ToolHeader from "@/app/components/ToolHeader";
import SiteFooter from "@/app/components/SiteFooter";
import PreflopTrainer from "./PreflopTrainer";
import "./pftrain.css";
import {
  type PfData,
  type PfFetchAttempt,
  PF_SOLUTION_URLS,
  buildPfDiag,
  fetchSolutionWithRetry,
} from "../preflop/trainerLogic";

/* ==============================================
   翻前训练独立页：数据与 /tools/preflop 同源（public/preflop-tree + R2 9max），
   套图清单这里维护一份（简介口径与范围表页可各自调整；
   URL/?v= 引 trainerLogic 的 PF_SOLUTION_URLS，唯一事实源）。
   ============================================== */

const SOLUTIONS: { id: string; short: string; brief: string; url: string }[] = [
  {
    id: "gg-zoom-3bb",
    short: "GG Zoom",
    brief: "6max · 100bb",
    url: PF_SOLUTION_URLS["gg-zoom-3bb"],
  },
  {
    id: "gg-zoom-2bb",
    short: "GG Zoom 2BB",
    brief: "6max · 100bb · 开牌固定 2bb",
    url: PF_SOLUTION_URLS["gg-zoom-2bb"],
  },
  {
    id: "gg-zoom-2p5bb",
    short: "GG Zoom 2.5BB",
    brief: "6max · 100bb · 开牌固定 2.5bb",
    url: PF_SOLUTION_URLS["gg-zoom-2p5bb"],
  },
  {
    id: "gg-10bb-hongbao",
    short: "GG 10BB红包桌",
    brief: "6max · 100bb · 每手 10bb 红包入池",
    url: PF_SOLUTION_URLS["gg-10bb-hongbao"],
  },
  {
    id: "gg-9max",
    short: "GG 9MAX",
    brief: "9max · 200bb",
    url: PF_SOLUTION_URLS["gg-9max"],
  },
];

export default function PreflopTrainPage() {
  const cacheRef = useRef(new Map<string, PfData>());
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [solId, setSolId] = useState(SOLUTIONS[0].id);
  const [data, setData] = useState<PfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* 自动重试进度（0=首次尝试中，1/2=第 n 次重试）：传给训练器显示 */
  const [retryNote, setRetryNote] = useState(0);
  /* 逐次尝试遥测（诊断用）：失败后一键复制成报告 */
  const [attempts, setAttempts] = useState<PfFetchAttempt[]>([]);
  const [diagCopied, setDiagCopied] = useState(false);
  /* 简化策略：独立页自持，不再与范围表页共享 */
  const [simplify, setSimplify] = useState(0);

  const applySolution = useCallback((d: PfData) => {
    setData(d);
    setError(null);
  }, []);

  const loadSolution = useCallback(
    (id: string) => {
      const sol = SOLUTIONS.find((s) => s.id === id)!;
      // seq 统一在此推进（缓存命中同样推进）：此前只有网络路径推进，慢树在途时
      // 切回缓存树不失效 seq，慢树落地时 seq 校验通过、整体劫持已切换的视图
      // （2026-11-03 审查 P1）
      const my = ++seqRef.current;
      const cached = cacheRef.current.get(id);
      if (cached) {
        setSolId(id);
        applySolution(cached);
        setLoading(false);
        setRetryNote(0);
        return;
      }
      setLoading(true);
      setError(null);
      setRetryNote(0);
      setAttempts([]);
      // 上一次在途请求直接中止：省带宽，也避免放弃的 9MAX（解析对象 ~200MB+）
      // 落地后照样完整解析入库，突破内存墙（客户端内存 ≈ 文件×6.5）
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // 超时/重试策略在 fetchSolutionWithRetry（与范围表页同源）：
      // 站内套 90s×3 次、R2 大树 240s×3 次，慢链路靠重试挤过去
      fetchSolutionWithRetry<PfData>(sol.url, ctrl.signal, {
        onRetry: (n) => {
          if (seqRef.current === my) setRetryNote(n);
        },
        onAttempt: (a) => {
          if (seqRef.current === my) setAttempts((prev) => [...prev, a]);
        },
      })
        .then((d: PfData) => {
          if (seqRef.current !== my) return; // 已被更新的选择作废：不缓存不应用
          // 缓存上限 3 份（4 套小树 + 1 套大树，全留会挤爆低内存设备），逐出最早入库的
          if (cacheRef.current.size >= 3) {
            const oldest = cacheRef.current.keys().next().value;
            if (oldest !== undefined) cacheRef.current.delete(oldest);
          }
          cacheRef.current.set(id, d);
          setSolId(id); // 成功才前进 solId：失败时名牌/矩阵/数据三者保持一致
          applySolution(d);
          setLoading(false);
          setRetryNote(0);
        })
        .catch((e) => {
          if (seqRef.current !== my) return;
          setError(
            e?.name === "AbortError"
              ? "加载超时（已尝试 3 次）——当前网络到站点较慢，可更换网络或开启代理后重试"
              : String(e.message || e)
          );
          setLoading(false);
          setRetryNote(0);
        });
    },
    [applySolution]
  );

  useEffect(() => {
    loadSolution(SOLUTIONS[0].id);
    return () => abortRef.current?.abort();
  }, [loadSolution]);

  /* 诊断报告复制：失败后一键把链路遥测发给站方 */
  const copyDiag = useCallback(async () => {
    const sol = SOLUTIONS.find((s) => s.id === solId) ?? SOLUTIONS[0];
    const text = buildPfDiag(sol.url, attempts, error ?? "(no error)");
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = !!window.prompt("复制以下诊断信息：", text);
    }
    setDiagCopied(ok);
    if (ok) setTimeout(() => setDiagCopied(false), 2500);
  }, [solId, attempts, error]);

  // solId 不再抢先前进：成功落地才切换，失败时名牌与数据保持一致（旧代码先
  // setSolId 再加载，失败后设置卡显示新树、矩阵还是旧树）
  const onSelectSet = useCallback(
    (id: string) => {
      loadSolution(id);
    },
    [loadSolution]
  );

  return (
    <>
      <Navbar />

      <section className="section pf-section" style={{ paddingTop: "4.75rem" }}>
        {/* 页头容器对齐顶栏 navbar-inner（80rem）：「翻前训练」标题落在顶栏品牌正下方，
            与其他工具页标题同一列起笔；不能复用 section-inner（72rem，宽视口下偏右） */}
        <div className="tr-headinner">
          <ToolHeader
            kicker="工具台 / 范围工具"
            title="翻前训练"
            glyph="range"
            actions={
              <Link
                href="/tools/preflop"
                className="tr-entry"
                title="查看同一套解算数据的范围矩阵"
              >
                <span className="tr-entry-dot" aria-hidden="true" />
                翻前范围表
              </Link>
            }
          />
        </div>
        <PreflopTrainer
          data={data}
          solId={solId}
          solutions={SOLUTIONS}
          loading={loading}
          retryNote={retryNote}
          error={error}
          onCopyDiag={copyDiag}
          diagCopied={diagCopied}
          onSelectSet={onSelectSet}
          simplify={simplify}
          onSimplifyChange={setSimplify}
        />
      </section>

      <SiteFooter />
    </>
  );
}
