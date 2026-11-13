"use client";

import { useRef, useState, useEffect } from "react";
import Navbar from "@/app/components/Navbar";
import ToolHeader from "@/app/components/ToolHeader";
import SiteFooter from "@/app/components/SiteFooter";

export default function LifeSimPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const sync = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        const h = Math.max(
          doc.body.scrollHeight,
          doc.documentElement.scrollHeight,
          600
        );
        setHeight(h);
      } catch {
        /* 跨域异常时回退到 minHeight，iframe 用自身滚动条 */
      }
    };

    let ro: ResizeObserver | null = null;
    const onLoad = () => {
      sync();
      const doc = iframe.contentDocument;
      if (!doc) return;
      ro?.disconnect(); // iframe 二次 load（bfcache 恢复等）不再叠加观察器
      ro = new ResizeObserver(sync);
      ro.observe(doc.body);
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, []);

  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="工具台 / 娱乐工具"
            title="扑克人生模拟"
            glyph="lifesim"
          />

          <iframe
            ref={iframeRef}
            src="/lifesim/poker-life-sim"
            title="德州扑克人生模拟器"
            style={{
              width: "100%",
              maxWidth: 640,
              margin: "0 auto",
              display: "block",
              border: "none",
              height,
            }}
          />
        </div>
      </section>

      <SiteFooter note="扑克人生模拟为第三方作品嵌入" />
    </>
  );
}
