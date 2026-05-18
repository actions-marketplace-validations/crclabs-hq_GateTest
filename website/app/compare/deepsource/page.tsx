import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest vs DeepSource — AI-Native Code Quality in 2026",
  description:
    "DeepSource finds issues. GateTest finds AND fixes them. 102 modules, pay-on-completion pricing, no per-seat licensing, AI-powered auto-fix PRs created in seconds.",
  keywords: [
    "DeepSource alternative",
    "DeepSource vs GateTest",
    "beyond DeepSource",
    "AI code quality 2026",
    "auto-fix PRs",
    "code review automation",
    "DeepSource replacement",
  ],
  alternates: {
    canonical: "https://gatetest.ai/compare/deepsource",
  },
  openGraph: {
    title: "GateTest vs DeepSource — AI-Native Code Quality in 2026",
    description:
      "DeepSource finds issues. GateTest finds AND fixes them. 102 modules, pay-on-completion pricing, no per-seat licensing, AI-powered auto-fix PRs.",
    url: "https://gatetest.ai/compare/deepsource",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "What does GateTest do that DeepSource doesn't?",
    a: "GateTest's key advantages over DeepSource: AI-powered code review using Claude (DeepSource uses static analysis, not generative AI), auto-fix PRs that write actual code changes (DeepSource shows issues, not fixes), pay-per-scan pricing (DeepSource is subscription per-seat), coverage of performance/visual regression/chaos testing/mutation testing (DeepSource is code quality and security only), and prompt/LLM safety scanning for AI apps.",
  },
  {
    q: "DeepSource has a free tier. Does GateTest?",
    a: "GateTest charges per scan: $29 quick scan (4 modules), $99 full scan (102 modules). No free tier currently. The key difference: GateTest's $99 scan includes AI code review, performance analysis, accessibility, visual regression, mutation testing, and 60+ other modules that require multi-tool subscriptions to replicate with DeepSource + extras.",
  },
  {
    q: "Does GateTest's AI fix code like DeepSource's Autofix?",
    a: "GateTest's Scan + Fix tier ($199) goes further than DeepSource Autofix. DeepSource Autofix generates fixes for a specific subset of analysis issues. GateTest uses Claude to read your entire codebase context and write fixes for any issue it finds — security misconfigurations, logic bugs, N+1 queries, accessibility violations — and opens a pull request with complete, reviewable code. The Nuclear tier ($399) adds attack-chain correlation across findings, a board-ready CISO report, and an executive summary report you can hand to a CTO. Mutation testing on your existing tests also ships via the GitHub Action with mutation: true — runs wherever your CI runs.",
  },
  {
    q: "How do scan speeds compare?",
    a: "GateTest quick scans (4 modules) complete in under 15 seconds. Full 102-module scans complete in under 60 seconds. DeepSource runs asynchronously in the background and varies widely by repo size. GateTest gives you synchronous results within the CI timeout window — no waiting for background workers.",
  },
  {
    q: "Does GateTest cover the same languages as DeepSource?",
    a: "Yes and more. GateTest has dedicated modules for Python, Go, Java, JavaScript, TypeScript, Ruby, PHP, C#, Kotlin, Swift, and Rust — plus the universal checker engine applies security and quality patterns across all languages simultaneously. DeepSource supports Python, Go, JavaScript, TypeScript, Java, and Ruby in its primary analyzers.",
  },
  {
    q: "Can GateTest replace DeepSource for continuous scanning?",
    a: "Yes. Install the GateTest GitHub App and every push to your repo triggers a scan automatically — commit status posted, PR comment added, full report available. The Continuous plan ($49/month) enables scans on every push. DeepSource's continuous model requires a subscription; GateTest's per-push scanning through the GitHub App is available on any paid plan.",
  },
];

const comparisonRows = [
  { feature: "Static code analysis", gatetest: true, competitor: true },
  { feature: "Security vulnerability detection", gatetest: true, competitor: true },
  { feature: "Multi-language support", gatetest: true, competitor: true },
  { feature: "AI code review (generative AI, not patterns)", gatetest: true, competitor: false },
  { feature: "Auto-fix PRs for any issue type", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing", gatetest: true, competitor: false },
  { feature: "Chaos testing", gatetest: true, competitor: false },
  { feature: "Prompt / LLM safety scanning", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat subscription)", gatetest: true, competitor: false },
  { feature: "102 modules in one gate", gatetest: true, competitor: false },
];

export default function DeepSourcePage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <div className="min-h-screen" style={{ background: "#0a0a12" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <Link href="/" className="text-sm text-white/50 hover:text-white transition-colors">
            &larr; Back to GateTest
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Compare</span>
          <span>/</span>
          <span className="text-white/60">DeepSource</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Tool Comparison
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest vs DeepSource
            <br />
            <span className="text-teal-400">AI-Native Code Quality in 2026</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            DeepSource is a solid static analysis tool. GateTest is an AI-native quality platform:
            102 modules, generative AI code review using Claude, auto-fix PRs that write real code,
            and pay-on-completion pricing with no per-seat subscriptions.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 mt-8">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Scan My Repo — From $29
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See All 90 Modules
            </Link>
          </div>
        </div>

        {/* AI advantage callout */}
        <section className="mb-16 rounded-xl border border-teal-500/20 p-6" style={{ background: "rgba(20,184,166,0.04)" }}>
          <h2 className="text-lg font-semibold text-teal-300 mb-3">The AI difference</h2>
          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <div className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-3">DeepSource approach</div>
              <p className="text-sm text-white/55 leading-relaxed">
                Rules-based static analysis. Detects patterns defined in analyzer rules — useful, but limited to what the rule authors anticipated. Can&rsquo;t reason about intent, context, or emergent bugs from code interaction.
              </p>
            </div>
            <div>
              <div className="text-teal-400 text-xs font-semibold uppercase tracking-wider mb-3">GateTest AI approach</div>
              <p className="text-sm text-white/55 leading-relaxed">
                Claude reads your code with full context — the function, its callers, the data it processes — and reasons about what the code <em>does</em>, not just how it looks. Catches logic bugs, off-by-one errors in financial code, and security issues that emerge from how code components interact.
              </p>
            </div>
          </div>
        </section>

        {/* Comparison table */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-6">Feature Comparison</h2>
          <div className="rounded-xl border border-white/[0.08] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.08]" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <th className="text-left px-5 py-4 text-white/50 font-medium">Feature</th>
                  <th className="text-center px-5 py-4 text-teal-400 font-semibold">GateTest</th>
                  <th className="text-center px-5 py-4 text-white/40 font-medium">DeepSource</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr
                    key={row.feature}
                    className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-5 py-3.5 text-white/70">{row.feature}</td>
                    <td className="px-5 py-3.5 text-center">
                      {row.gatetest ? (
                        <span className="text-emerald-400 font-bold text-base">&#10003;</span>
                      ) : (
                        <span className="text-white/20">&#8212;</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {row.competitor ? (
                        <span className="text-emerald-400/60 font-bold text-base">&#10003;</span>
                      ) : (
                        <span className="text-red-400/60">&#10007;</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Key differentiators */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">Why teams switch from DeepSource</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Fixes, not just findings",
                body: "DeepSource Autofix covers a subset of its own analysis rules. GateTest's AI auto-fix covers everything it finds: security misconfigs, N+1 queries, accessibility violations, code quality issues, TypeScript strictness regressions — any issue GateTest detects, it can write a fix for and open as a PR.",
              },
              {
                title: "Pay for what you use",
                body: "DeepSource charges a monthly subscription per seat. A 10-person team might run 5 scans a month or 500 — the bill is the same. GateTest charges per result: $99 for all 102 modules per scan. Scan before releases, scan after major features, scan daily — you control the spend.",
              },
              {
                title: "Coverage beyond code quality",
                body: "DeepSource focuses on code quality and security. GateTest adds visual regression (screenshot comparison between deploys), mutation testing (validates your tests actually catch bugs), chaos testing, performance analysis, accessibility audits, and AI safety scanning — dimensions no static analyzer covers.",
              },
              {
                title: "Faster synchronous results",
                body: "DeepSource runs asynchronously — you push, wait for the background scan to complete, then check the dashboard. GateTest returns results synchronously within the CI window: commit status posted, PR comment added, full report available before your CI pipeline finishes.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="rounded-xl p-5 border border-white/[0.08]"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <h3 className="text-white font-semibold mb-2">{card.title}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqItems.map((item) => (
              <div
                key={item.q}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <h3 className="text-white font-semibold mb-3 leading-snug">{item.q}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            Find issues. Fix issues. Ship faster.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            102 modules, AI-powered review, auto-fix PRs — all in one scan. Pay only when results are delivered.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Scan My Repo — From $29
          </Link>
          <p className="text-white/30 text-xs mt-6">
            Card hold only. Charged after successful scan delivery.
          </p>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8 mt-16">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex items-center gap-6">
            <Link href="/compare/sonarqube" className="hover:text-white/60 transition-colors">vs SonarQube</Link>
            <Link href="/compare/snyk" className="hover:text-white/60 transition-colors">vs Snyk</Link>
            <Link href="/compare/eslint" className="hover:text-white/60 transition-colors">vs ESLint</Link>
            <Link href="/compare/github-code-scanning" className="hover:text-white/60 transition-colors">vs GitHub Code Scanning</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
