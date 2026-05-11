const moves = [
  {
    num: "01",
    title: "Claude Opus 4.7 adaptive thinking",
    body: "Every diagnosis uses the most capable AI model in the world with extended adaptive reasoning. Competitors use pattern-match regex. We use thought.",
    tag: "AI",
  },
  {
    num: "02",
    title: "Cross-finding attack chain correlation",
    body: "Bug A alone is low severity. Bug B alone is medium. A + B together = session forgery. We find the chain. No competitor does this.",
    tag: "Unique",
  },
  {
    num: "03",
    title: "Iterative fix loop with self-validation",
    body: "We attempt each fix, re-run that finding in isolation, and retry up to 3× with failure context. We don't ship broken fixes.",
    tag: "Unique",
  },
  {
    num: "04",
    title: "Fake-fix detector",
    body: "If Claude produces a symptom patch instead of a root-cause fix, we reject it. The only QA tool with a detector for its own outputs.",
    tag: "Unique",
  },
  {
    num: "05",
    title: "Mutation testing — tests that test your tests",
    body: "We flip your code logic (== to !=, true to false, > to <) and verify your test suite catches it. Tests that pass all mutations mean nothing.",
    tag: "Depth",
  },
  {
    num: "06",
    title: "Pay only when the PR is delivered",
    body: "Scan fails? You pay $0. PR opens? You pay. Every competitor charges for finding bugs. We charge for fixing them.",
    tag: "Pricing",
  },
  {
    num: "07",
    title: "90 scan modules",
    body: "SonarQube covers ~10 categories. Snyk covers ~4. GateTest covers 90. Money float precision, cron impossible dates, async iteration footguns, import cycles, PII flows — nobody else gets near this.",
    tag: "Breadth",
  },
  {
    num: "08",
    title: "Static ↔ runtime LIVE badge",
    body: "We cross-reference Datadog / Sentry runtime errors against static findings. If your static bug is actively throwing in production, it gets a 🔥 LIVE badge and jumps to the top.",
    tag: "Unique",
  },
  {
    num: "09",
    title: "Cross-repo intelligence brain",
    body: "Every scan builds a private fingerprint. When we diagnose your bug, we know what fixed the same pattern in 1,000 other repos. The product gets smarter with every customer.",
    tag: "Moat",
  },
  {
    num: "10",
    title: "Closed feedback loop — self-improving",
    body: "Every rolled-back PR, thumbs-down, and false positive trains the confidence scorer. False-positive rates trend down automatically over time.",
    tag: "Moat",
  },
  {
    num: "11",
    title: "Property-based test generation",
    body: "Beyond regression tests, we generate fast-check properties: type-shape invariants, idempotency, boundary cases. Nuclear only.",
    tag: "Testing",
  },
  {
    num: "12",
    title: "Chaos / failure injection tests",
    body: "We generate tests that mock fetch, setTimeout, and fs to inject failures and assert graceful degradation. No competitor generates chaos tests.",
    tag: "Testing",
  },
  {
    num: "13",
    title: "Mutation-strengthened regression tests",
    body: "We generate a regression test, then run all 12 mutation operators against it. If any mutation passes, we rewrite the test to be stronger.",
    tag: "Testing",
  },
  {
    num: "14",
    title: "Performance benchmark before/after",
    body: "Every fix to a hot path ships with a tinybench benchmark comparing original vs fixed implementation across small and large inputs.",
    tag: "Testing",
  },
  {
    num: "15",
    title: "Pair review agent",
    body: "A second Claude instance reads every (original → fixed) diff and scores correctness, completeness, readability, and test coverage 1-5 with a critique.",
    tag: "Quality",
  },
  {
    num: "16",
    title: "Dependency upgrade patcher",
    body: "Detect major version gaps, ask Claude for breaking API changes, scan every file that references the dep, patch all call sites, syntax-gate the output.",
    tag: "Automation",
  },
  {
    num: "17",
    title: "Security policy applier",
    body: "Detect Express / Next / Fastify entry points missing CSP, CSRF, or rate-limiting. Auto-patch them with framework-specific headers.",
    tag: "Security",
  },
  {
    num: "18",
    title: "CISO-ready compliance report",
    body: "Every Nuclear scan auto-generates a board-ready PDF with OWASP Top 10, SOC2 Trust Criteria, CIS Controls v8 mapping + 30/60/90-day remediation roadmap.",
    tag: "Compliance",
  },
  {
    num: "19",
    title: "Executive summary",
    body: "Claude synthesises 90-module findings into one CTO-readable document: headline posture score, top 3 actions, what's working well, recommended next step.",
    tag: "Reporting",
  },
  {
    num: "20",
    title: "Multi-file architectural refactors",
    body: "Not line-level patches. We detect polling → webhook, in-memory state → Redis, untyped fetch → typed client patterns and refactor every call site in one PR.",
    tag: "Unique",
  },
];

const tagColor: Record<string, string> = {
  "Unique":      "bg-violet-500/10 text-violet-400 border-violet-500/20",
  "AI":          "bg-teal-500/10 text-teal-400 border-teal-500/20",
  "Moat":        "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "Depth":       "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "Pricing":     "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "Breadth":     "bg-rose-500/10 text-rose-400 border-rose-500/20",
  "Testing":     "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "Quality":     "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  "Automation":  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  "Security":    "bg-red-500/10 text-red-400 border-red-500/20",
  "Compliance":  "bg-purple-500/10 text-purple-400 border-purple-500/20",
  "Reporting":   "bg-pink-500/10 text-pink-400 border-pink-500/20",
};

export default function MonsterMoves() {
  return (
    <section className="py-24 px-6 border-t border-border/30 bg-[#0a0a12] relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-violet-500/3 to-transparent pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="inline-block px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold uppercase tracking-widest mb-4">
            Why GateTest Wins
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
            20 capabilities no competitor
            <br />
            <span className="hero-accent-text">has shipped. Not even close.</span>
          </h2>
          <p className="text-white/50 text-lg max-w-2xl mx-auto">
            We&apos;re not 10% better than SonarQube. We&apos;re not 30% better than Snyk.
            These are capabilities that don&apos;t exist anywhere else in the market.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {moves.map((move) => (
            <div
              key={move.num}
              className="group relative rounded-xl border border-white/8 bg-white/[0.02] p-5 hover:border-white/15 hover:bg-white/[0.04] transition-all"
            >
              <div className="flex items-start justify-between mb-3">
                <span className="text-2xl font-black text-white/10 font-mono leading-none">{move.num}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${tagColor[move.tag] || "bg-white/5 text-white/40 border-white/10"}`}>
                  {move.tag}
                </span>
              </div>
              <h3 className="text-sm font-bold text-white mb-2 leading-snug">{move.title}</h3>
              <p className="text-xs text-white/45 leading-relaxed">{move.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
          <a href="#pricing" className="hero-cta px-8 py-3.5 text-sm rounded-xl font-semibold">
            Get started — From $29
          </a>
          <a href="/fixes" className="text-sm text-white/50 hover:text-white transition-colors">
            See real PRs we delivered →
          </a>
        </div>
      </div>
    </section>
  );
}
