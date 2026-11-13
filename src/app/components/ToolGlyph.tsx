import type { GlyphName } from "./tools";

/**
 * 工具图标：统一发丝线条语言，替代各页的 emoji。
 * 全部 24×24、1.5px 描边、无外框，靠 currentColor 适配金色/灰阶。
 */
export default function ToolGlyph({
  name,
  className,
}: {
  name: GlyphName;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >

      {name === "ban2note" && (
        <>
          <path d="M6.5 3.5h7.9l4.1 4.1v12.9H6.5z" />
          <path d="M14.4 3.5v4.2h4.1" />
          <path d="M9.4 16.6v-4.2M12 16.6v-6.4M14.6 16.6v-2.8" />
          <path d="M8.4 18.7h9" opacity=".45" />
        </>
      )}

      {name === "pomodoro" && (
        <>
          <circle cx="12" cy="13.4" r="7.3" />
          <path d="M12 9.7v4l2.6 1.7" />
          <path d="M9.7 3.6h4.6" />
          <path d="M16.9 6.5l1.5-1.5" />
        </>
      )}

      {name === "equity" && (
        <>
          <rect
            x="3.2"
            y="5.6"
            width="7.4"
            height="10.6"
            rx="1.3"
            transform="rotate(-8 6.9 10.9)"
          />
          <rect
            x="13.4"
            y="7.8"
            width="7.4"
            height="10.6"
            rx="1.3"
            transform="rotate(8 17.1 13.1)"
          />
          <path d="M11.4 6.2h1.2" opacity=".45" />
        </>
      )}

      {name === "lifesim" && (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <circle cx="9" cy="9" r=".95" fill="currentColor" stroke="none" />
          <circle cx="15" cy="9" r=".95" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r=".95" fill="currentColor" stroke="none" />
          <circle cx="9" cy="15" r=".95" fill="currentColor" stroke="none" />
          <circle cx="15" cy="15" r=".95" fill="currentColor" stroke="none" />
        </>
      )}

      {name === "solver" && (
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2.2" />
          <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" opacity=".55" />
          <path d="M3.5 3.5h5.7v5.7H3.5z" fill="currentColor" stroke="none" opacity=".85" />
          <path d="M14.8 14.8h5.7v5.7h-5.7z" fill="currentColor" stroke="none" opacity=".3" />
        </>
      )}


      {name === "range" && (
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
          <path d="M7.75 3.5v17M12 3.5v17M16.25 3.5v17M3.5 7.75h17M3.5 12h17M3.5 16.25h17" opacity=".35" />
          <path d="M3.5 3.5h4.25v4.25H3.5z" fill="currentColor" stroke="none" opacity=".9" />
          <path d="M12 12h4.25v4.25H12z" fill="currentColor" stroke="none" opacity=".55" />
          <path d="M7.75 16.25H12v4.25H7.75z" fill="currentColor" stroke="none" opacity=".3" />
        </>
      )}
      {name === "train" && (
        <>
          <path d="M3.5 9.5L12 5l8.5 4.5L12 14z" />
          <path d="M7 11.4v4.2c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.2" />
          <path d="M20.5 9.6v5" />
        </>
      )}


      {name === "member" && (
        <>
          <circle cx="12" cy="8.6" r="3.4" />
          <path d="M5.2 20.5c1.2-3.8 3.7-5.7 6.8-5.7s5.6 1.9 6.8 5.7" />
        </>
      )}
      {name === "squid" && (
        <>
          <path d="M12 3.5c3.7 0 6.3 2.8 6.3 6.2 0 2.5-1.3 4.4-3.2 5.5" />
          <path d="M12 3.5c-3.7 0-6.3 2.8-6.3 6.2 0 2.5 1.3 4.4 3.2 5.5" />
          <circle cx="9.6" cy="10.4" r=".95" fill="currentColor" stroke="none" />
          <circle cx="14.4" cy="10.4" r=".95" fill="currentColor" stroke="none" />
          <path d="M8.6 16.6c-.5 1.5-1.5 2.5-3 3.1" />
          <path d="M12 15.6v4.3" />
          <path d="M15.4 16.6c.5 1.5 1.5 2.5 3 3.1" />
        </>
      )}
    </svg>
  );
}
