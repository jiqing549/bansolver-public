import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import SiteFooter from "@/app/components/SiteFooter";
import ToolHeader from "@/app/components/ToolHeader";
import { ToolJsonLd, enPageMetadata } from "@/app/components/toolSeo";
import "../../../guide/guide.css";

const title =
  "GG Zoom Preflop Charts — Free GTO Ranges with Frequencies & EV | BanSolver";
const description =
  "GTO preflop ranges for GG Zoom cash games: open-raising, facing raises, 3bet / 4bet and short-stack shove charts in a 13×13 matrix with per-hand frequencies and EV. RocketSolver solves, free online.";

export const metadata: Metadata = enPageMetadata({
  path: "/en/tools/preflop",
  title,
  description,
  zhPath: "/tools/preflop",
});

export default function EnPreflopPage() {
  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="TOOLKIT / PREFLOP"
            title="GG Zoom Preflop Charts"
            desc="RocketSolver GTO solves as an interactive matrix — every hand's frequency and EV, one click deep."
            glyph="range"
            backLabel="← All tools"
            backHref="/en"
          />

          <div className="guide-body">
            <article className="guide-section">
              <h2>What&apos;s inside</h2>
              <ul>
                <li>GG Zoom 100BB full preflop tree: RFI, vs. raise, 3bet / 4bet and squeeze lines.</li>
                <li>Short-stack formats: 2.5BB and 2BB shove-or-fold structures.</li>
                <li>10BB red-packet table charts for the fast bounty format.</li>
                <li>Color-coded 13×13 matrix: color depth is the action frequency; hover for exact numbers.</li>
                <li>EV heatmap mode and per-node navigation between streets and positions.</li>
              </ul>
            </article>

            <article className="guide-section">
              <h2>How to read it</h2>
              <ol>
                <li>Upper-left half of the matrix is suited hands (AKs), lower-right is offsuit (AKo), the diagonal is pairs.</li>
                <li>Pick a position and spot to see the range; darker means more frequent.</li>
                <li>Switch the view to EV to see which hands actually pay the bills.</li>
              </ol>
              <p>
                The charts are a lookup companion for real tables: keep it open
                between hands, check the spot you just played, move on.{" "}
                <Link className="btn-gold" href="/tools/preflop">
                  Open the range charts →
                </Link>
              </p>
              <p>
                Not sure how to study ranges? Start with the{" "}
                <Link href="/en/guide">study guide</Link>, or bring your{" "}
                <Link href="/en/tools/ban2note">
                  GGPoker hand histories
                </Link>{" "}
                and look up the exact spots you misplayed.
              </p>
            </article>
          </div>
        </div>
      </section>

      <SiteFooter />

      <ToolJsonLd
        path="/en/tools/preflop"
        name="GG Zoom Preflop Charts"
        description={description}
        lang="en"
      />
    </>
  );
}
