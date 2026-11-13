import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import SiteFooter from "@/app/components/SiteFooter";
import ToolHeader from "@/app/components/ToolHeader";
import JsonLd from "@/app/components/JsonLd";
import { ToolJsonLd, zhPageMetadata } from "@/app/components/toolSeo";
import "./guide.css";

const title = "扑克攻略与常见问题 · GG牌谱复盘 / 范围表 / 方差入门 - 千算Poker";
const description =
  "GG 牌谱怎么导出与复盘、翻前范围表怎么读、方差与资金管理怎么算——扑克工具入门攻略与常见问题，全部免费。";

export const metadata: Metadata = zhPageMetadata({
  path: "/guide",
  title,
  description,
  enPath: "/en/guide",
});

const FAQ = [
  {
    q: "BanSolver 收费吗？需要注册吗？",
    a: "全部工具免费，无需注册账号。打开浏览器就能用，电脑和手机都支持。",
  },
  {
    q: "我的牌谱会被上传到服务器吗？",
    a: "会。解析在你的浏览器本地完成，但牌谱文本会上传一份到服务器做云端备份，用于问题排查和新功能开发，介意勿用。",
  },
  {
    q: "支持哪些平台的牌谱？",
    a: "目前支持 GGPoker（含 zip 套 zip 的整包导出）与 CoinPoker 的牌谱格式，其他平台陆续增加中。",
  },
  {
    q: "翻前范围表的数据来自哪里？",
    a: "来自 RocketSolver 求解树的 GTO 解，覆盖 GG Zoom 常见盲注结构（含 10BB / 2.5BB / 2BB 短码），可在矩阵里查看每手的出现频率与 EV。",
  },
  {
    q: "现金桌该准备多少个买入？",
    a: "经验法则是常规桌 20–50 个买入起步，波动承受力弱就往上加。",
  },
];

export default function GuidePage() {
  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="工具台 / 攻略"
            title="扑克攻略与常见问题"
            desc="从 GG 牌谱导出到复盘、范围表、方差与资金管理——先把工具用对，再谈牌技。"
            glyph="ban2note"
          />

          <div className="guide-body">
            <article className="guide-section">
              <h2>GG 牌谱怎么导出、怎么复盘？</h2>
              <p>
                在 GGPoker 客户端里打开「牌局记录 / Hand History」，按日期选择并下载，
                会得到 .txt 牌谱文件或打包好的 zip（整包下载经常是 zip 套 zip，直接拖进来即可，不用手动解压）。
              </p>
              <ol>
                <li>
                  把下载好的牌谱文件或 zip 拖进{" "}
                  <Link href="/tools/ban2note">Ban2Note 数据复盘</Link>{" "}
                  ——解析在你的浏览器本地完成；牌谱文本会上传一份到服务器做云端备份（用于问题排查与功能开发）。
                </li>
                <li>先看总盈亏曲线和位置统计，确认数据量完整、没有漏掉会话。</li>
                <li>
                  再用去重功能排除重复导入的手数，然后重点翻 all-in 与大底池：
                  大部分长期亏损都藏在这两类手里。
                </li>
              </ol>
              <p>
                建议固定一个复盘节奏，比如每周一次：先扫曲线找异常点，再下钻到手数级细节，
                最后把结论写成一句话笔记——比「多看十遍牌谱」更有用。
              </p>
            </article>

            <article className="guide-section">
              <h2>翻前范围表怎么读？</h2>
              <p>
                范围表是一个 13×13 手牌矩阵：左上半区是同花（如 AKs），
                右下半区是杂色（如 AKo），对角线是对子（如 AA）。
                每格的颜色深浅代表这一手在该位置的行动频率——颜色越深，越常这么打。
              </p>
              <ol>
                <li>
                  先记 RFI（无人进池时第一个开牌的范围）：从 UTG 到 Button，位置越靠后范围越宽。
                </li>
                <li>再记面对加注的防守：3bet、跟注、弃牌的边界，是翻前最容易亏钱的地方。</li>
                <li>
                  短码结构（10BB 及以下的急速桌）先看全压/弃牌两条线，规则简单，实战收益立竿见影。
                </li>
              </ol>
              <p>
                <Link href="/tools/preflop">翻前范围表</Link>{" "}
                支持在不同盲注结构和节点之间自由穿梭，每一手都能看到具体频率与 EV，
                可以当成打牌间隙的速查手册用。
              </p>
            </article>

            <article className="guide-section">
              <h2>方差与资金管理：连输 20 手正常吗？</h2>
              <p>
                完全正常。德州扑克即使整体胜率占优，短期连败也是数学上的必然——
                这就是方差。问题从来不是「会不会遇到下风期」，而是「遇到时你的买入够不够厚」。
              </p>
              <p>
                经验法则：常规桌至少备 20–50 个买入，锦标赛 100 个起。
              </p>
            </article>

            <article className="guide-section">
              <h2>Equity（胜率）怎么算？</h2>
              <p>
                Equity 是指当前牌局进行到摊牌时，你赢下整个底池的概率。
                手牌对手牌可以精确穷举算出精确值；手牌对范围则用 Monte Carlo 抽样近似。
              </p>
              <p>
                <Link href="/tools/odds">Equity 计算器</Link>{" "}
                采用 PokerStove 语义：支持范围语法、2–6 人底池，全部在浏览器本地计算，
                复盘 all-in 决策时对一下数字，能快速校正手感偏差。
              </p>
            </article>

            <hr className="guide-divider" />

            <section className="guide-section" aria-labelledby="guide-faq">
              <h2 id="guide-faq">常见问题</h2>
              <dl className="guide-faq">
                {FAQ.map((f) => (
                  <div key={f.q}>
                    <dt>{f.q}</dt>
                    <dd>{f.a}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      </section>

      <SiteFooter />

      <ToolJsonLd
        path="/guide"
        name="千算Poker 扑克攻略"
        description={description}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }}
      />
    </>
  );
}
