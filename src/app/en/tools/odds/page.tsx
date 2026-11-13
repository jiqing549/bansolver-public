import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import SiteFooter from "@/app/components/SiteFooter";
import ToolHeader from "@/app/components/ToolHeader";
import { ToolJsonLd, enPageMetadata } from "@/app/components/toolSeo";
import "../../../guide/guide.css";

const title =
  "Poker Equity Calculator — Exact Hand vs Range Odds | BanSolver";
const description =
  "PokerStove-style poker equity calculator: exact enumeration for hand vs hand, Monte Carlo for ranges, 2–6 player pots. Runs entirely in your browser, free, no signup.";

export const metadata: Metadata = enPageMetadata({
  path: "/en/tools/odds",
  title,
  description,
  zhPath: "/tools/odds",
});

export default function EnOddsPage() {
  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="TOOLKIT / MATH"
            title="Poker Equity Calculator"
            desc="PokerStove semantics, zero install: exact enumeration for hands, Monte Carlo for ranges."
            glyph="equity"
            backLabel="← All tools"
            backHref="/en"
          />

          <div className="guide-body">
            <article className="guide-section">
              <h2>What it does</h2>
              <ul>
                <li>Hand vs. hand matchups solved by exact enumeration — no sampling error.</li>
                <li>Hand or range vs. range via Monte Carlo, with PokerStove-style range syntax.</li>
                <li>2–6 player pots, preflop through river boards.</li>
                <li>Interactive range grid: click or drag to build ranges on a 13×13 matrix.</li>
              </ul>
            </article>

            <article className="guide-section">
              <h2>How to use it</h2>
              <ol>
                <li>Pick the players, enter hands or paint ranges on the grid.</li>
                <li>Set the board (or leave it empty for preflop).</li>
                <li>Read the equity — then compare it to the pot odds you had in-game.</li>
              </ol>
              <p>
                Checking your all-in decisions against real numbers is the
                fastest way to recalibrate feel.{" "}
                <Link className="btn-gold" href="/tools/odds">
                  Calculate equity →
                </Link>
              </p>
              <p>
                Review real hands first with{" "}
                <Link href="/en/tools/ban2note">
                  GGPoker hand history analysis
                </Link>
                .
              </p>
            </article>
          </div>
        </div>
      </section>

      <SiteFooter />

      <ToolJsonLd
        path="/en/tools/odds"
        name="Poker Equity Calculator"
        description={description}
        lang="en"
      />
    </>
  );
}
