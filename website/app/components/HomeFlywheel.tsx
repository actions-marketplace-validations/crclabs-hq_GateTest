/**
 * <HomeFlywheel> — the 4-layer fix flow that nobody else ships.
 *
 * The moat:
 *   1. AST fix — deterministic, ~47% of TLS-class issues (free, no Claude call)
 *   2. Rule fix — regex/codemod recipe, ~22% of cookie/CORS issues
 *   3. Recipe — accumulated wins from prior scans, compounds over time
 *   4. Claude — only the novel ~5% reaches the LLM
 *
 * Why HN respects this: it's the right way to architect AI-assisted code
 * tooling. Deterministic layers eat the cheap, fast, reliable wins; the
 * model handles only the genuinely novel cases. This is also why our
 * margin works on pay-per-completion — most fixes cost us $0.
 *
 * "Self-healing CI" tail: when CI breaks, the agent reads the log,
 * patches the code, opens a PR. You review and merge.
 */

import Link from "next/link";

interface Layer {
  step: string;
  name: string;
  cost: string;
  share: string;
  blurb: string;
  detail: string;
}

const LAYERS: Layer[] = [
  {
    step: "01",
    name: "AST fix",
    cost: "$0",
    share: "~47%",
    blurb: "Deterministic transforms on the parse tree.",
    detail:
      "rejectUnauthorized: false → true. httpOnly: false → true. The compiler proves correctness; no LLM needed.",
  },
  {
    step: "02",
    name: "Rule fix",
    cost: "$0",
    share: "~22%",
    blurb: "Codemod recipes per finding class.",
    detail:
      "Wildcard CORS origin + credentials. Missing CSP. Cookie hardening. One regex-bounded rewrite per pattern.",
  },
  {
    step: "03",
    name: "Recipe lookup",
    cost: "$0",
    share: "~16%",
    blurb: "Cached fixes from every prior scan, compounding.",
    detail:
      "When a scan resolves a novel finding, the diff is stored. Next time that finding shape arrives — local or someone else&apos;s repo — we apply the cached patch.",
  },
  {
    step: "04",
    name: "Claude",
    cost: "~$0.03",
    share: "~5%",
    blurb: "Only the genuinely novel cases reach the LLM.",
    detail:
      "Iterative loop with N retries, syntax gate, scanner re-validation, pair-review on $199+, attack-chain correlation on $399.",
  },
];

export default function HomeFlywheel() {
  return (
    <section id="flywheel" className="py-24 px-6 border-t border-border bg-background-alt">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            The flywheel
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Four layers. <span className="gradient-text">Compounding.</span>
          </h2>
          <p className="text-muted text-lg max-w-3xl mx-auto">
            Every competitor either ships pattern matchers (cheap, brittle)
            or ships LLM-only fixes (slow, expensive, hallucinates). We
            stack four deterministic layers in front of Claude. Most fixes
            never reach the LLM. Margin works. Quality compounds.
          </p>
        </div>

        {/* Layer flow diagram */}
        <div className="grid md:grid-cols-4 gap-4 mb-12">
          {LAYERS.map((layer, idx) => (
            <div
              key={layer.step}
              className="relative rounded-2xl border border-border bg-surface-solid p-6 flex flex-col"
            >
              {/* Arrow to next */}
              {idx < LAYERS.length - 1 && (
                <div
                  aria-hidden="true"
                  className="hidden md:block absolute -right-3 top-1/2 -translate-y-1/2 z-10"
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 22 22"
                    fill="none"
                    className="text-accent/40"
                  >
                    <path
                      d="M5 11h12m0 0l-5-5m5 5l-5 5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              )}

              <div className="flex items-center justify-between mb-4">
                <span className="font-mono text-xs text-muted tracking-wider">
                  {layer.step}
                </span>
                <span className="text-xs font-semibold text-accent">
                  {layer.share}
                </span>
              </div>

              <h3 className="text-lg font-bold text-foreground mb-1">
                {layer.name}
              </h3>
              <div className="text-xs font-mono text-muted mb-3">
                cost per fix: <span className="text-accent">{layer.cost}</span>
              </div>
              <p className="text-sm text-foreground/85 font-medium mb-3">
                {layer.blurb}
              </p>
              <p className="text-xs text-muted leading-relaxed mt-auto">
                {layer.detail}
              </p>
            </div>
          ))}
        </div>

        {/* Self-healing CI tail */}
        <div className="rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/[0.06] to-accent/[0.02] p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row items-start gap-4">
            <div className="shrink-0 w-12 h-12 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-accent"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c-2.5 0-4.5-4-4.5-9S9.5 3 12 3m0 18c2.5 0 4.5-4 4.5-9S14.5 3 12 3m0 0a9 9 0 0 0-9 9" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-foreground mb-2">
                Self-healing CI
              </h3>
              <p className="text-sm text-muted leading-relaxed">
                When CI breaks, the agent reads the failing log, walks back to
                the failing line, applies the right layer (AST &rarr; rule
                &rarr; recipe &rarr; Claude), runs the gate again, opens a PR.
                You review the diff and merge. The build was red for fifteen
                minutes; you didn&apos;t have to look at it. The recipe layer
                remembers, so the next time the same failure happens — your
                repo or someone else&apos;s — it&apos;s fixed before you see it.
              </p>
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover font-medium mt-3"
              >
                How it actually works
                <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
          </div>
        </div>

        <p className="text-xs text-muted text-center mt-8">
          Layer percentages are derived from our own self-scan + the four
          real-repo proofs in{" "}
          <code className="font-mono text-accent">docs/proofs/</code>. Your
          mileage will vary by tier and codebase shape.
        </p>
      </div>
    </section>
  );
}
