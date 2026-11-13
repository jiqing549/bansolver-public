import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import SiteFooter from "@/app/components/SiteFooter";
import ToolHeader from "@/app/components/ToolHeader";
import JsonLd from "@/app/components/JsonLd";
import { ToolJsonLd, enPageMetadata } from "@/app/components/toolSeo";
import "../../guide/guide.css";

const title =
  "Poker Study Guide — Hand History Review, Preflop Charts, Variance | BanSolver";
const description =
  "How to export and review GGPoker hand histories, how to read preflop range charts, variance and bankroll rules of thumb, and how poker equity works — a plain-language guide.";

export const metadata: Metadata = enPageMetadata({
  path: "/en/guide",
  title,
  description,
  zhPath: "/guide",
});

const FAQ = [
  {
    q: "Is BanSolver free? Do I need an account?",
    a: "Every tool is free and requires no signup. Open the page and use it, on desktop or mobile.",
  },
  {
    q: "Are my hand histories uploaded to a server?",
    a: "Yes. Parsing happens locally in your browser, but a copy of the hand history text is uploaded to our server as a cloud backup, used for troubleshooting and developing new features. Skip it if you're not comfortable with that.",
  },
  {
    q: "Which platforms are supported?",
    a: "GGPoker (including full-account zip-of-zips exports) and CoinPoker hand histories. More platforms are on the way.",
  },
  {
    q: "Where do the preflop charts come from?",
    a: "From RocketSolver GTO solves, covering common GG Zoom blind structures including 10BB / 2.5BB / 2BB short-stack formats, with per-hand frequencies and EV in the matrix.",
  },
  {
    q: "How many buy-ins should I have for cash games?",
    a: "A common rule of thumb is 20–50 buy-ins minimum; more if variance hurts your game.",
  },
];

export default function EnGuidePage() {
  return (
    <>
      <Navbar />

      <section className="section" style={{ paddingTop: "4.75rem" }}>
        <div className="section-inner">
          <ToolHeader
            kicker="TOOLKIT / GUIDE"
            title="Poker Study, in Plain Language"
            desc="From exporting GGPoker hands to reading range charts and surviving variance — use the tools right before worrying about strategy."
            glyph="ban2note"
            backLabel="← All tools"
            backHref="/en"
          />

          <div className="guide-body">
            <article className="guide-section">
              <h2>How to export and review GGPoker hand histories</h2>
              <p>
                In the GGPoker client, open the hand history section, pick your
                dates and download — you get .txt files or a packaged zip
                (full-account exports are often a zip inside a zip; drag it in
                as-is, no manual unzipping needed).
              </p>
              <ol>
                <li>
                  Drop the files into{" "}
                  <Link href="/en/tools/ban2note">Ban2Note</Link>{" "}
                  — parsing happens locally in your browser; a copy of the
                  text is uploaded to our server as a cloud backup.
                </li>
                <li>
                  Start with the profit curve and position stats to confirm the
                  sample is complete and no session is missing.
                </li>
                <li>
                  Use duplicate detection to clean re-imported hands, then go
                  straight to all-ins and big pots — that is where long-term
                  losses hide.
                </li>
              </ol>
              <p>
                A fixed review rhythm (say, weekly) beats binge-watching
                replayer: scan the curve for anomalies, drill into the hands
                behind them, and write a one-line conclusion for each.
              </p>
            </article>

            <article className="guide-section">
              <h2>How to read a preflop range chart</h2>
              <p>
                A range chart is a 13×13 matrix: the upper-left half is suited
                combos (AKs), the lower-right half is offsuit (AKo), and the
                diagonal is pairs (AA). Color depth shows how often that hand
                takes the action at that position — the deeper the color, the
                more often.
              </p>
              <ol>
                <li>
                  Learn RFI ranges first (open-raising when the action folds to
                  you): UTG is tightest, the button is widest.
                </li>
                <li>
                  Then learn defense vs. a raise — the 3bet / call / fold
                  borders are where most preflop money leaks.
                </li>
                <li>
                  For short-stack formats (10BB and below), start with the
                  shove-or-fold charts: simple rules, immediate payoff.
                </li>
              </ol>
              <p>
                The <Link href="/en/tools/preflop">preflop charts</Link>{" "}
                let you move between blind structures and tree nodes freely,
                with per-hand frequencies and EV — treat them as a lookup
                companion, not homework.
              </p>
            </article>

            <article className="guide-section">
              <h2>Variance and bankroll: is losing 20 in a row normal?</h2>
              <p>
                Completely. Even a winning player faces brutal downswings —
                that is variance, not a leak. The question is never whether a
                downswing will come, but whether your bankroll survives it.
              </p>
              <p>
                Rule of thumb: 20–50 buy-ins for cash games, 100+ for
                tournaments.
              </p>
            </article>

            <article className="guide-section">
              <h2>What exactly is equity?</h2>
              <p>
                Equity is your share of the pot — the probability you win at
                showdown from this point forward. Hand vs. hand can be computed
                by exact enumeration; hand vs. range uses Monte Carlo sampling.
              </p>
              <p>
                The <Link href="/en/tools/odds">equity calculator</Link>{" "}
                follows PokerStove semantics: range syntax, 2–6 player pots,
                fully local computation. Checking your all-in decisions against
                real numbers is the fastest way to recalibrate feel.
              </p>
            </article>

            <hr className="guide-divider" />

            <section className="guide-section" aria-labelledby="en-faq">
              <h2 id="en-faq">FAQ</h2>
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
        path="/en/guide"
        name="BanSolver Poker Study Guide"
        description={description}
        lang="en"
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          inLanguage: "en",
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
