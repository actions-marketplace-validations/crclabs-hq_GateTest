/**
 * <HomeFaq> — HN-skeptic FAQ.
 *
 * The question shapes are calibrated for the audience that lands at 3am
 * from a Hacker News link: skeptical of AI tools, allergic to lock-in,
 * suspicious of "pay for everything" pricing.
 *
 * Use <details> / <summary> — native HTML, keyboard-friendly, zero JS,
 * screen-reader-friendly, ships with no dependency.
 */

import Link from "next/link";

interface Faq {
  q: string;
  a: React.ReactNode;
}

const FAQS: Faq[] = [
  {
    q: "Is this just another AI tool?",
    a: (
      <>
        No. The static engine ships first: 91 deterministic modules — AST,
        regex, file walkers — zero LLM calls. Claude only enters when the
        deterministic layers can&apos;t resolve a finding (roughly 5% of
        fixes). The 4-layer{" "}
        <a href="#flywheel" className="text-accent hover:underline">
          flywheel architecture
        </a>{" "}
        is the moat.
      </>
    ),
  },
  {
    q: "Is my code stored anywhere?",
    a: (
      <>
        No. Scans are ephemeral. We clone, run the engine, post the report,
        delete the clone. The repo never leaves your CI environment when
        you install the GitHub Action — we never see it. For paid scans run
        from our infra, the working copy lives on a Vercel function for the
        duration of the scan and is gone when the response returns.{" "}
        <Link href="/legal/privacy" className="text-accent hover:underline">
          Privacy policy.
        </Link>
      </>
    ),
  },
  {
    q: "Why not just ESLint + Snyk + the other 10 tools?",
    a: (
      <>
        You can. Most teams do. The question is who maintains the
        compose-of-ten — and who pays the per-seat tax across all of them.
        We replace 30+ tools with one CLI, one config, one bill. See{" "}
        <a href="#kills-table" className="text-accent hover:underline">
          the full replacement table
        </a>{" "}
        or compare us{" "}
        <Link href="/compare" className="text-accent hover:underline">
          tool-by-tool
        </Link>
        .
      </>
    ),
  },
  {
    q: "Pay-on-completion — what's the catch?",
    a: (
      <>
        None. We hold your card via Stripe Payment Intent (manual capture),
        run the scan, and capture only if the scan delivers a usable report.
        If the scan crashes, times out, or returns garbage — the hold is
        released and you pay zero. The model only works because the
        scan-finish rate is well above 99% on real repos; we eat the cost of
        the few that fail.
      </>
    ),
  },
  {
    q: "Is the gate actually strict?",
    a: (
      <>
        Yes. Bible Forbidden #24 outright bans{" "}
        <code className="font-mono text-accent text-xs">
          continue-on-error: true
        </code>{" "}
        on the gate step. We dog-food this: our own{" "}
        <a href="#self-scan" className="text-accent hover:underline">
          self-scan
        </a>{" "}
        is a hard gate on every push to main. If a competitor lets you
        silently skip a failing check, that&apos;s how 80% of the wins in
        QA-platform marketing slip into prod anyway.
      </>
    ),
  },
  {
    q: "Can I trust an AI to repair my CI?",
    a: (
      <>
        The fix-flow is layered for exactly that reason: AST &rarr; rule
        recipe &rarr; cached pattern &rarr; Claude. Each layer&apos;s output
        passes a syntax gate and a scanner re-validation gate before the PR
        opens. Claude never auto-merges — it opens a PR you review. At the
        $199+ tiers a second Claude pair-reviews every fix on a 4-axis
        rubric (correctness, completeness, readability, test coverage).
        Real outputs are documented in{" "}
        <code className="font-mono text-accent text-xs">docs/proofs/</code>.
      </>
    ),
  },
];

export default function HomeFaq() {
  return (
    <section id="faq" className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-3xl">
        <div className="text-center mb-12">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            FAQ
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-3 text-foreground">
            Common skeptical questions.
          </h2>
          <p className="text-muted text-base max-w-xl mx-auto">
            Answers calibrated for the engineer who showed up from a Hacker
            News thread. We are too.
          </p>
        </div>

        <div className="space-y-2">
          {FAQS.map((faq, i) => (
            <details
              key={i}
              className="group rounded-xl border border-border bg-surface-solid overflow-hidden transition-colors hover:border-accent/30"
            >
              <summary className="px-5 py-4 cursor-pointer flex items-start justify-between gap-4 list-none font-semibold text-foreground hover:text-accent transition-colors">
                <span>{faq.q}</span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-muted group-open:text-accent transition-transform duration-200 group-open:rotate-45 text-xl leading-none font-light"
                >
                  +
                </span>
              </summary>
              <div className="px-5 pb-5 -mt-1 text-sm text-muted leading-relaxed">
                {faq.a}
              </div>
            </details>
          ))}
        </div>

        <p className="text-center text-sm text-muted mt-10">
          Still have questions?{" "}
          <a
            href="mailto:hello@gatetest.ai"
            className="text-accent hover:underline font-medium"
          >
            hello@gatetest.ai
          </a>{" "}
          &middot;{" "}
          <a
            href="https://github.com/crclabs-hq/GateTest/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline font-medium"
          >
            file an issue
          </a>
        </p>
      </div>
    </section>
  );
}
