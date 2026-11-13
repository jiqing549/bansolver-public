"use client";

/* ================================================================
   CreditsRail — 左侧留白区的荣耀致谢滚动栏
   ================================================================
   仅在 ≥1900px 宽屏出现（CSS 控制），窄屏自动隐藏。
   名单高度超过滚动视窗时无缝循环滚动（track 渲染两份名单，
   translateY(-50%)），悬停暂停，prefers-reduced-motion 退化为
   静态可滚动；名单不足一屏时（ResizeObserver 测量）自动静态
   展示，不出克隆列也不滚动。头像加载失败降级为首字母金环。
   数据见 credits.ts。
   ================================================================ */

import { useEffect, useRef, useState } from "react";
import { CREDITS, type CreditEntry } from "./credits";

function CreditItem({ entry }: { entry: CreditEntry }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <li className="ban2note-credit-item">
      <div className="ban2note-credit-avatar">
        {entry.avatar && !imgFailed ? (
          // 静态导出 + 本地小图，<img> 即可；next/image 对 out 导出无收益
          // eslint-disable-next-line @next/next/no-img-element
          <img src={entry.avatar} alt={`${entry.name} 的头像`} loading="lazy" onError={() => setImgFailed(true)} />
        ) : (
          <span className="ban2note-credit-mono" aria-hidden="true">
            {/* 展开按码点取首字符：emoji（代理对）用 charAt 会被劈成半个乱码 */}
            {[...entry.name.trim()][0]?.toUpperCase() ?? ""}
          </span>
        )}
      </div>
      <div className="ban2note-credit-name">{entry.name}</div>
      <div className="ban2note-credit-note">{entry.note}</div>
    </li>
  );
}

export default function CreditsRail() {
  const windowRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // 名单是否满一屏：满了才滚动，不满静态展示
  const [marquee, setMarquee] = useState(false);

  useEffect(() => {
    const win = windowRef.current;
    const list = listRef.current;
    if (!win || !list) return;
    const check = () => setMarquee(list.scrollHeight > win.clientHeight);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(list);
    ro.observe(win);
    // RO 依赖渲染管线，后台/节流标签页可能不投递；resize 兜底
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, []);

  return (
    <aside className="ban2note-credits" aria-label="荣耀致谢">
      <div className="ban2note-credits-head">
        <span className="ban2note-credits-title">荣耀致谢</span>
        <span className="ban2note-credits-sub">CREDITS</span>
      </div>
      <div
        ref={windowRef}
        className={`ban2note-credits-window${marquee ? "" : " ban2note-credits-window--static"}`}
      >
        <div className="ban2note-credits-track">
          <ul ref={listRef} className="ban2note-credits-list">
            {CREDITS.map((c, i) => (
              <CreditItem key={`${c.name}-${i}`} entry={c} />
            ))}
          </ul>
          {/* 复制一份做无缝循环，aria-hidden 避免读屏重复 */}
          <ul className="ban2note-credits-list ban2note-credits-list--clone" aria-hidden="true">
            {CREDITS.map((c, i) => (
              <CreditItem key={`clone-${c.name}-${i}`} entry={c} />
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
