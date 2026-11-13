import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import SiteFooter from "@/app/components/SiteFooter";
import ToolHeader from "@/app/components/ToolHeader";
import JsonLd from "@/app/components/JsonLd";
import { enPageMetadata } from "@/app/components/toolSeo";
import "../guide/guide.css";

const title =
  "Free Poker Tools — GGPoker Hand History Review, Preflop Charts | BanSolver";
const description =
  "Free browser-based poker tools: GGPoker & CoinPoker hand history analyzer, GTO preflop charts for GG Zoom, equity calculator. No signup, local parsing with cloud backup.";

export const metadata: Metadata = enPageMetadata({
  path: "/en",
  title,
  description,
  zhPath: "/",
});

export default function EnHome() {
  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="TOOLKIT / ALL TOOLS"
            title="Free Poker Tools by BanSolver"
            desc="A small toolkit built by players, for players. Everything runs in your browser, hands get a cloud backup, and every tool is free."
            glyph="ban2note"
            backLabel="← 中文站"
            backHref="/"
          />

          <div className="guide-body">
            <article className="guide-section">
              <h2>Hand history review</h2>
              <p>
                Exported a pile of GGPoker hand histories and never opened them?{" "}
                <Link href="/en/tools/ban2note">Ban2Note</Link>{" "}
                parses them right in your browser — profit curves, position
                breakdowns, showdown review and duplicate detection, even for
                zip-of-zips full-account exports. Your hands are never uploaded
                anywhere.
              </p>
              <p>
                <Link className="btn-gold" href="/en/tools/ban2note">
                  GGPoker hand history analyzer →
                </Link>
              </p>
            </article>

            <article className="guide-section">
              <h2>Preflop charts</h2>
              <p>
                GTO preflop ranges for GG Zoom cash games, solved with
                RocketSolver and served as an interactive 13×13 matrix: open-raising,
                facing raises, 3bet / 4bet lines and short-stack shove ranges
                (100BB, 2.5BB, 2BB and 10BB red-packet tables), each hand with
                its exact frequency and EV.{" "}
                <Link href="/en/tools/preflop">Open the preflop charts →</Link>
              </p>
            </article>

            <article className="guide-section">
              <h2>The math side</h2>
              <p>
                Compare hands and ranges with exact enumeration in the{" "}
                <Link href="/en/tools/odds">equity calculator</Link>.
              </p>
            </article>

            <article className="guide-section">
              <h2>Study &amp; sanity</h2>
              <p>
                The <Link href="/tools/pomodoro">poker pomodoro</Link>{" "}
                keeps sessions short with forced breaks, and the{" "}
                <Link href="/tools/lifesim">poker life simulator</Link>{" "}
                lets you live a whole pro career — 18 talents, 110+ events,
                15+ endings — without risking a single buy-in.
              </p>
            </article>

            <article className="guide-section">
              <h2>New here? Start with the guide</h2>
              <p>
                Never done structured study before?{" "}
                <Link href="/en/guide">Read the plain-language guide</Link>:
                how to export and review GGPoker hands, how to read a preflop
                matrix, and the variance rules that keep bankrolls alive.
              </p>
            </article>
          </div>
        </div>
      </section>

      <SiteFooter />

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "BanSolver — Free Poker Tools",
          alternateName: "BanSolver",
          url: "https://bansolver.com/en",
          inLanguage: "en",
          description,
        }}
      />
    </>
  );
}
