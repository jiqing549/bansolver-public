import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import SiteFooter from "@/app/components/SiteFooter";
import ToolHeader from "@/app/components/ToolHeader";
import { ToolJsonLd, enPageMetadata } from "@/app/components/toolSeo";
import "../../../guide/guide.css";

const title =
  "GGPoker Hand History Analyzer — Free, Browser-Based Review | BanSolver";
const description =
  "Drag your GGPoker or CoinPoker hand histories into the browser: profit curves, position stats, all-in review and duplicate detection. Runs locally, hands never leave your device. Free, no signup.";

export const metadata: Metadata = enPageMetadata({
  path: "/en/tools/ban2note",
  title,
  description,
  zhPath: "/tools/ban2note",
});

export default function EnBan2NotePage() {
  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="TOOLKIT / HAND HISTORY"
            title="GGPoker Hand History Analyzer"
            desc="Full-account exports, zip-of-zips included. Parse, review and dedupe — entirely inside your browser."
            glyph="ban2note"
            backLabel="← All tools"
            backHref="/en"
          />

          <div className="guide-body">
            <article className="guide-section">
              <h2>What it does</h2>
              <ul>
                <li>Parses GGPoker and CoinPoker hand histories, including full-account zips nested inside zips.</li>
                <li>Profit and EV curves over any hand range, with sessions marked out.</li>
                <li>Position-based breakdowns: where you actually make (or lose) your money.</li>
                <li>All-in and showdown review with adjusted EV, so bad beats stop distorting your read.</li>
                <li>Duplicate detection across re-imports, so your numbers stay clean.</li>
              </ul>
            </article>

            <article className="guide-section">
              <h2>How to use it</h2>
              <ol>
                <li>In the GGPoker client, open the hand history section, select your dates and download.</li>
                <li>Drag the file (or the whole zip) onto the analyzer — parsing runs locally in your browser.</li>
                <li>Scan the curve for anomalies, then drill into the hands behind them.</li>
              </ol>
              <p>
                Privacy is the whole point: your hands are processed on your
                device and never uploaded anywhere. Close the tab and it is all
                gone.
              </p>
              <p>
                <Link className="btn-gold" href="/tools/ban2note">
                  Analyze my hand histories →
                </Link>
              </p>
              <p>
                New to hand review? Read the{" "}
                <Link href="/en/guide">plain-language study guide</Link>, or
                pair this with the{" "}
                <Link href="/en/tools/preflop">GG Zoom preflop charts</Link>{" "}
                to check the spots you flagged.
              </p>
            </article>
          </div>
        </div>
      </section>

      <SiteFooter />

      <ToolJsonLd
        path="/en/tools/ban2note"
        name="Ban2Note — GGPoker Hand History Analyzer"
        description={description}
        lang="en"
      />
    </>
  );
}
