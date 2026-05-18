import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest vs ESLint — Why 2026 Developers Are Moving On",
  description:
    "ESLint is one tool. GateTest is 90. Security, performance, accessibility, visual regression, mutation testing, AI code review — all in one gate. Auto-fix included.",
  keywords: [
    "ESLint alternative",
    "ESLint vs GateTest",
    "beyond ESLint",
    "code quality beyond linting",
    "ESLint replacement",
    "AI code review",
    "static analysis 2026",
  ],
  alternates: {
    canonical: "https://gatetest.ai/compare/eslint",
  },
  openGraph: {
    title: "GateTest vs ESLint — Why 2026 Developers Are Moving On",
    description:
      "ESLint is one tool. GateTest is 90. Security, performance, accessibility, visual regression, mutation testing, AI code review — all in one gate.",
    url: "https://gatetest.ai/compare/eslint",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "Does GateTest replace ESLint, or do I use both?",
    a: "GateTest includes an ESLint-equivalent lint module as one of 90. You get linting plus security scanning, performance analysis, accessibility checks, AI code review, mutation testing, and 60+ more dimensions — all in a single scan. Most teams use GateTest at the CI gate and optionally keep ESLint running in their editor for instant feedback while coding.",
  },
  {
    q: "ESLint is free. Why would I pay for GateTest?",
    a: "ESLint catches style and pattern violations. GateTest catches bugs that cost real money: N+1 queries degrading your database, race conditions in auth flows, SSRF vulnerabilities in API handlers, PII leaking into logs, float arithmetic breaking financial calculations. ESLint can't find any of those. The cost of one production incident exceeds a year of GateTest scans.",
  },
  {
    q: "Does GateTest require an .eslintrc or configuration files?",
    a: "No configuration files required. GateTest detects your project type automatically and applies the right rules. Zero setup: paste your repo URL and get results in under 60 seconds.",
  },
  {
    q: "Can GateTest auto-fix issues like ESLint --fix?",
    a: "ESLint --fix handles formatting and simple pattern replacements. GateTest's AI auto-fix (Scan + Fix, $199) handles actual bug fixes — adding validation guards, restructuring dangerous code patterns, fixing security misconfigurations — and opens a pull request with the changes for your review. The Nuclear tier ($399) goes deeper: Claude-driven per-finding diagnosis, attack-chain correlation, a board-ready CISO report, and an executive summary. Mutation testing on your existing tests also ships via the GitHub Action with mutation: true — runs wherever your CI runs.",
  },
  {
    q: "What does GateTest catch that ESLint misses?",
    a: "ESLint is a pattern matcher — it checks syntax trees against rules. GateTest includes: AI-powered semantic code review (finds logic bugs ESLint rules don't cover), security scanning (OWASP Top 10 patterns), N+1 query detection, race condition analysis, resource leak detection, accessibility audits, performance profiling, visual regression, mutation testing, and 40+ more. ESLint cannot reason about what your code does — only how it's written.",
  },
  {
    q: "Does GateTest support TypeScript like ESLint does?",
    a: "Yes. GateTest's TypeScript module goes beyond @typescript-eslint: it catches tsconfig regressions (strict: false, noImplicitAny: false), @ts-ignore abuse, any-type leaks in exported signatures, and unused exports. It also includes the full lint module for TypeScript-specific style rules.",
  },
];

const comparisonRows = [
  { feature: "Syntax & style linting", gatetest: true, competitor: true },
  { feature: "TypeScript-aware checks", gatetest: true, competitor: true },
  { feature: "Auto-fix (code-level bugs, not just style)", gatetest: true, competitor: false },
  { feature: "AI code review (semantic bug detection)", gatetest: true, competitor: false },
  { feature: "Security vulnerability scanning", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing", gatetest: true, competitor: false },
  { feature: "Zero configuration required", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat)", gatetest: true, competitor: false },
  { feature: "90 scanning modules total", gatetest: true, competitor: false },
];

export default function EsLintPage() {
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
          <span className="text-white/60">ESLint</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Tool Comparison
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest vs ESLint
            <br />
            <span className="text-teal-400">Why 2026 Developers Are Moving On</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            ESLint is great at what it does — and what it does is pattern matching on syntax trees.
            GateTest is 90 tools in one: it includes everything ESLint does, plus security scanning,
            AI code review, N+1 detection, accessibility, performance, mutation testing, and 60 more
            dimensions that no linter can touch.
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

        {/* The linting iceberg */}
        <section className="mb-16 rounded-xl border border-teal-500/20 p-6" style={{ background: "rgba(20,184,166,0.04)" }}>
          <h2 className="text-lg font-semibold text-teal-300 mb-3">The linting iceberg</h2>
          <p className="text-white/60 text-sm mb-5">
            ESLint catches the surface — style violations, unused variables, missing semicolons. GateTest also scans below the waterline:
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="rounded-lg border border-teal-500/20 p-4" style={{ background: "rgba(20,184,166,0.06)" }}>
              <div className="text-teal-400 text-xs font-semibold uppercase tracking-wider mb-2">ESLint handles</div>
              <ul className="text-xs text-white/55 space-y-1">
                <li>Syntax errors</li>
                <li>Unused variables</li>
                <li>Consistent style</li>
                <li>Simple anti-patterns</li>
              </ul>
            </div>
            <div className="rounded-lg border border-white/10 p-4 sm:col-span-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <div className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">GateTest adds (+66 more dimensions)</div>
              <ul className="text-xs text-white/55 space-y-1 grid grid-cols-2 gap-x-4">
                <li>N+1 database queries</li>
                <li>SSRF vulnerabilities</li>
                <li>Race conditions</li>
                <li>Resource leaks</li>
                <li>PII in logs</li>
                <li>Prompt injection</li>
                <li>Float money bugs</li>
                <li>Import cycles</li>
                <li>TLS bypass patterns</li>
                <li>ReDoS regex</li>
                <li>Accessibility (WCAG)</li>
                <li>Visual regression</li>
              </ul>
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
                  <th className="text-center px-5 py-4 text-white/40 font-medium">ESLint</th>
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
          <h2 className="text-2xl font-bold text-white mb-8">What ESLint simply can&rsquo;t do</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Semantic understanding vs syntax patterns",
                body: "ESLint matches patterns in your AST. It can tell you that you used == instead of === — but it can't tell you that the loop on line 47 makes a database query on every iteration. GateTest's N+1 detector understands what the code does, not just how it looks.",
              },
              {
                title: "AI code review with real reasoning",
                body: "GateTest sends your code to Claude with full context — the function, its callers, its data flow. The AI identifies real bugs: off-by-one errors in financial calculations, missing error handling in async chains, logic inversions in conditional branches. ESLint has no rule for any of this.",
              },
              {
                title: "Security that ESLint plugins miss",
                body: "eslint-plugin-security exists and it's useful — but it's limited to simple patterns. GateTest's security modules use data-flow analysis: tracking taint from req.body to fetch() to flag SSRF, following variable assignments across functions to find TLS bypass, detecting when cookie options flow into response headers without httpOnly: true.",
              },
              {
                title: "Zero-config, cross-language",
                body: "ESLint requires configuration per project and only runs on JS/TS. GateTest detects your stack automatically — JS, TS, Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, Swift — and applies the right checks with no configuration file required.",
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
            One gate. 102 modules. Zero config.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Keep ESLint in your editor. Add GateTest to your CI gate for everything ESLint can&rsquo;t see.
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
            <Link href="/compare/github-code-scanning" className="hover:text-white/60 transition-colors">vs GitHub Code Scanning</Link>
            <Link href="/compare/deepsource" className="hover:text-white/60 transition-colors">vs DeepSource</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
