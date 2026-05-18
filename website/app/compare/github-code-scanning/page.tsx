import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest vs GitHub Code Scanning — The Complete QA Platform",
  description:
    "GitHub Code Scanning covers security basics. GateTest covers 90 quality dimensions: security, performance, accessibility, AI safety, visual regression, chaos testing, and auto-fix.",
  keywords: [
    "GitHub Code Scanning alternative",
    "GitHub Advanced Security alternative",
    "CodeQL alternative",
    "beyond GitHub security",
    "complete QA platform",
    "GateTest vs GitHub",
    "GHAS alternative",
  ],
  alternates: {
    canonical: "https://gatetest.ai/compare/github-code-scanning",
  },
  openGraph: {
    title: "GateTest vs GitHub Code Scanning — The Complete QA Platform",
    description:
      "GitHub Code Scanning covers security basics. GateTest covers 90 quality dimensions: security, performance, accessibility, AI safety, visual regression, chaos testing, and auto-fix.",
    url: "https://gatetest.ai/compare/github-code-scanning",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "Does GateTest work alongside GitHub Code Scanning, or replace it?",
    a: "GateTest can replace GitHub Code Scanning entirely — it posts the same commit statuses, creates the same PR comments, and covers all the security patterns CodeQL finds plus 60+ additional quality dimensions. If you already have GHAS and want to keep it, GateTest adds everything GitHub Code Scanning doesn't cover (performance, accessibility, visual regression, chaos testing, AI code review, and more).",
  },
  {
    q: "GitHub Code Scanning is included in my GitHub plan. Why would I pay extra for GateTest?",
    a: "GitHub Code Scanning (CodeQL) is a security-only tool with a well-defined scope: known vulnerability patterns in your code. It has zero coverage of performance, accessibility, visual regression, mutation testing, AI safety, N+1 queries, datetime bugs, money/float precision, feature flag hygiene, or any of the 40+ other dimensions GateTest covers. The cost of one accessibility lawsuit, one performance-related churn, or one money-float audit exceeds a year of GateTest scans.",
  },
  {
    q: "Does GateTest post commit statuses and PR comments like GitHub Code Scanning does?",
    a: "Yes — identical workflow integration. Install the GateTest GitHub App once, and every push gets a commit status (pass/fail) with a link to the full report. Every PR gets a formatted comment with per-module results, severity counts, file references, and line numbers. The developer workflow is indistinguishable from GitHub Code Scanning — but with 102 modules instead of CodeQL's security-only scope.",
  },
  {
    q: "GitHub Code Scanning is free for public repos. Does GateTest offer anything similar?",
    a: "GateTest's pricing is per scan ($29 quick / $99 full 102 modules). There's no subscription or per-seat billing — a public-repo open-source project pays exactly the same as an enterprise. We don't currently offer a free tier, but $99 for a full 102-module scan including AI code review is substantially cheaper than what GitHub Advanced Security costs at enterprise scale.",
  },
  {
    q: "Does GateTest work with repos on git hosts other than GitHub?",
    a: "Yes. GateTest was built with a host-agnostic HostBridge abstraction. It supports GitHub natively and Gluecron via the Signal Bus. Support for additional git hosts is in the roadmap. GitHub Code Scanning is GitHub-exclusive.",
  },
  {
    q: "Can GateTest auto-fix the issues it finds?",
    a: "Yes. The Scan + Fix tier ($199) creates a pull request with code changes that fix the issues found. GitHub Code Scanning shows you security alerts and leaves fixing to you. GateTest writes the fix. The Nuclear tier ($399) adds Claude-driven per-finding diagnosis, cross-finding attack-chain correlation, a board-ready CISO report, and a CTO-readable executive summary. Mutation testing and chaos / fuzz pass also ship via the GitHub Action (mutation: true / chaos: true) — runs wherever your CI runs.",
  },
];

const comparisonRows = [
  { feature: "Security vulnerability detection", gatetest: true, competitor: true },
  { feature: "AI code review (semantic bug detection)", gatetest: true, competitor: false },
  { feature: "Auto-fix pull requests", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing", gatetest: true, competitor: false },
  { feature: "Chaos testing", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "Prompt / LLM safety scanning", gatetest: true, competitor: false },
  { feature: "Works with non-GitHub git hosts", gatetest: true, competitor: false },
  { feature: "Pay per scan (no per-seat licensing)", gatetest: true, competitor: false },
  { feature: "90 scanning modules total", gatetest: true, competitor: false },
  { feature: "PR / commit status integration", gatetest: true, competitor: true },
  { feature: "SARIF output format", gatetest: true, competitor: true },
];

export default function GitHubCodeScanningPage() {
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
          <span className="text-white/60">GitHub Code Scanning</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Tool Comparison
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest vs GitHub Code Scanning
            <br />
            <span className="text-teal-400">The Complete QA Platform</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            GitHub Code Scanning (CodeQL) is a well-engineered security tool with one job: finding
            known vulnerability patterns. It&rsquo;s good at that job. But security is one of 90
            quality dimensions your code needs — and GitHub Code Scanning covers exactly one of them.
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

        {/* Coverage gap visual */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-6">What GitHub Code Scanning doesn&rsquo;t cover</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { label: "Performance", items: ["Core Web Vitals", "Bundle size", "N+1 queries", "Lighthouse scores"] },
              { label: "Accessibility", items: ["WCAG 2.2 automated audit", "ARIA checks", "Color contrast", "Keyboard nav"] },
              { label: "Code Quality", items: ["Cyclomatic complexity", "Dead code", "Import cycles", "TypeScript strictness"] },
              { label: "Reliability", items: ["Race conditions", "Resource leaks", "Retry hygiene", "Error swallowing"] },
              { label: "AI Safety", items: ["Prompt injection", "Cost DoS (no max_tokens)", "Browser-exposed keys", "Deprecated models"] },
              { label: "Visual & UX", items: ["Screenshot regression", "Responsive layout", "Mutation testing (via Action)", "Chaos testing (via Action)"] },
            ].map((group) => (
              <div
                key={group.label}
                className="rounded-xl border border-red-500/15 p-4"
                style={{ background: "rgba(239,68,68,0.04)" }}
              >
                <div className="text-red-400 text-xs font-semibold uppercase tracking-wider mb-3">
                  &#10007; GitHub CS misses: {group.label}
                </div>
                <ul className="text-xs text-white/50 space-y-1">
                  {group.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ))}
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
                  <th className="text-center px-5 py-4 text-white/40 font-medium">GitHub Code Scanning</th>
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
          <h2 className="text-2xl font-bold text-white mb-8">The complete picture</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Same workflow, 67x more coverage",
                body: "GateTest posts commit statuses and PR comments in exactly the same format as GitHub Code Scanning. The developer experience is identical — install the GitHub App, push code, see results on the PR. But instead of security-only CodeQL alerts, you get 102 modules: security, performance, accessibility, AI safety, visual regression, and more.",
              },
              {
                title: "AI code review CodeQL can't do",
                body: "CodeQL works from a database of query patterns. GateTest sends your code to Claude for semantic reasoning — understanding what the code intends, identifying logic bugs, spotting off-by-one errors in financial calculations, flagging race conditions in auth flows. Pattern databases can't catch logic errors. AI can.",
              },
              {
                title: "Auto-fix, not just alerts",
                body: "GitHub Code Scanning shows you security alerts. You investigate, understand the issue, write the fix, test it. GateTest writes the fix and opens a pull request. The Scan + Fix tier covers both finding and fixing — security issues, code quality problems, configuration misconfigurations. The Nuclear tier adds attack-chain correlation, a board-ready CISO report, and a CTO-readable executive summary on top. Mutation testing and chaos / fuzz pass also ship via the GitHub Action where a CI runner is present.",
              },
              {
                title: "Host-agnostic by design",
                body: "GitHub Code Scanning is permanently tied to GitHub. GateTest's HostBridge architecture means it works across git hosts — GitHub today, Gluecron and others as the ecosystem evolves. If you ever migrate away from GitHub, your quality gate moves with you.",
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
            Security is just the beginning.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Get 90 quality dimensions in one scan — security, performance, accessibility, AI safety,
            visual regression, and more. Same PR workflow as GitHub Code Scanning.
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
            <Link href="/compare/deepsource" className="hover:text-white/60 transition-colors">vs DeepSource</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
