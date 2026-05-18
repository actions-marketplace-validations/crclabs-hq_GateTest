import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest vs SonarQube — The Smarter Alternative in 2026",
  description:
    "GateTest replaces SonarQube with 102 AI-powered modules, AI auto-fix PRs at the Scan + Fix tier and above, and pay-on-completion pricing. No complex setup. No per-seat licensing. Just results.",
  keywords: [
    "SonarQube alternative",
    "SonarQube vs GateTest",
    "better than SonarQube",
    "SonarQube replacement",
    "AI code quality",
    "automated code review",
    "static analysis alternative",
  ],
  alternates: {
    canonical: "https://gatetest.ai/compare/sonarqube",
  },
  openGraph: {
    title: "GateTest vs SonarQube — The Smarter Alternative in 2026",
    description:
      "GateTest replaces SonarQube with 102 AI-powered modules, AI auto-fix PRs at the Scan + Fix tier and above, and pay-on-completion pricing. No complex setup. No per-seat licensing.",
    url: "https://gatetest.ai/compare/sonarqube",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "Does GateTest replace SonarQube completely?",
    a: "Yes. GateTest covers everything SonarQube does — code quality, security patterns, technical debt, and duplication — plus 50+ modules SonarQube doesn't have: AI code review, visual regression, mutation testing, accessibility (WCAG 2.2 AAA), performance, Kubernetes manifest scanning, and more. One tool, one dashboard, one gate.",
  },
  {
    q: "How does GateTest pricing compare to SonarQube?",
    a: "SonarQube Cloud charges per active user per month. SonarQube Community Edition requires you to run your own server. GateTest charges per scan — $29 for a quick scan, $99 for all 102 modules. You pay only when the scan completes and delivers results. No server to maintain, no per-seat licensing, no annual contracts.",
  },
  {
    q: "Does GateTest post commit statuses and PR comments like SonarQube does?",
    a: "Yes. Install the GateTest GitHub App and every push gets a commit status (pass/fail) and every PR gets a formatted comment with per-module results, severity counts, and direct links to the issues. Identical workflow integration — better results.",
  },
  {
    q: "Is GateTest harder to set up than SonarQube?",
    a: "Dramatically easier. SonarQube requires running a server, configuring sonar-project.properties, setting up a scanner in CI, and managing database migrations. GateTest is zero-config: paste your repo URL, pay, get results. The GitHub App auto-scans on every push with no configuration file required.",
  },
  {
    q: "Does GateTest support languages other than JavaScript and TypeScript?",
    a: "Yes. GateTest includes 9 dedicated language modules covering Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, and Swift — in addition to deep JS/TS support. SonarQube's JavaScript/TypeScript coverage is one product tier; GateTest includes all languages in the $99 full scan.",
  },
  {
    q: "Can GateTest fix the issues it finds, like a PR suggestion?",
    a: "GateTest goes further than suggestions. The AI-powered auto-fix mode (Scan + Fix, $199) creates an actual pull request with working code changes. SonarQube shows you the issue; GateTest writes the fix. The Nuclear tier ($399) adds Claude-driven diagnosis per finding, attack-chain correlation across findings, a board-ready CISO report, and a CTO-readable executive summary. Mutation testing also ships via the GitHub Action with mutation: true — runs wherever your CI runs.",
  },
];

const comparisonRows = [
  { feature: "90 scanning modules", gatetest: true, competitor: false },
  { feature: "AI code review (Claude)", gatetest: true, competitor: false },
  { feature: "Auto-fix pull requests", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat)", gatetest: true, competitor: false },
  { feature: "Zero server setup", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing", gatetest: true, competitor: false },
  { feature: "Kubernetes / Terraform / Dockerfile scanning", gatetest: true, competitor: false },
  { feature: "Prompt / LLM safety scanning", gatetest: true, competitor: false },
  { feature: "Pay-on-completion (charged only when results delivered)", gatetest: true, competitor: false },
  { feature: "Code smell & duplication detection", gatetest: true, competitor: true },
  { feature: "Security vulnerability detection", gatetest: true, competitor: true },
  { feature: "CI/CD integration", gatetest: true, competitor: true },
  { feature: "PR / commit status feedback", gatetest: true, competitor: true },
];

export default function SonarQubePage() {
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
          <Link
            href="/"
            className="text-sm text-white/50 hover:text-white transition-colors"
          >
            &larr; Back to GateTest
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/compare/sonarqube" className="text-white/60">Compare</Link>
          <span>/</span>
          <span className="text-white/60">SonarQube</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Tool Comparison
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest vs SonarQube
            <br />
            <span className="text-teal-400">The Smarter Alternative in 2026</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            SonarQube was built in 2006 — before AI, before cloud-native CI/CD, before modern
            security threats. GateTest is built for 2026: 102 AI-powered modules, AI auto-fix PRs at the Scan + Fix tier ($199) and above,
            zero server setup, and pay-on-completion pricing.
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

        {/* Comparison table */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-6">Feature Comparison</h2>
          <div className="rounded-xl border border-white/[0.08] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.08]" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <th className="text-left px-5 py-4 text-white/50 font-medium">Feature</th>
                  <th className="text-center px-5 py-4 text-teal-400 font-semibold">GateTest</th>
                  <th className="text-center px-5 py-4 text-white/40 font-medium">SonarQube</th>
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
          <h2 className="text-2xl font-bold text-white mb-8">Why developers are switching</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "AI-native, not AI-bolted-on",
                body: "SonarQube added AI features to a 2006 rule engine. GateTest is built AI-first — Claude reads your actual code, understands context, and finds bugs that pattern matching misses. Real bugs, not rule violations.",
              },
              {
                title: "Auto-fix PRs, not just reports",
                body: "SonarQube tells you what's wrong and leaves you to fix it. At the Scan + Fix tier ($199) and Nuclear ($399), GateTest writes the fix and opens a pull request. You review, you merge. No debugging, no manual remediation, no guessing at the right fix.",
              },
              {
                title: "Zero server infrastructure",
                body: "SonarQube requires a running server, a database, and ongoing maintenance. SonarQube Cloud still requires sonar-project.properties and scanner configuration per project. GateTest: paste URL, get results. No config files, no servers, no ops burden.",
              },
              {
                title: "102 modules vs 1 focus",
                body: "SonarQube focuses on code quality and security patterns. GateTest covers those plus accessibility, visual regression, performance, mutation testing, N+1 queries, race conditions, TLS misconfigs, PII in logs, homoglyph attacks, and 40+ more dimensions — all in one scan.",
              },
              {
                title: "Pay per scan, not per seat",
                body: "SonarQube Cloud pricing scales with developer headcount — the more your team grows, the higher your bill. GateTest charges per result: $29 quick scan, $99 full 102-module scan. A 50-person team pays the same as a solo founder for the same scan.",
              },
              {
                title: "Faster feedback loop",
                body: "SonarQube quality gates can take minutes on large projects. GateTest quick scans complete in under 15 seconds, full scans under 60 seconds. Every push gets instant feedback — no waiting for a background worker to catch up.",
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
            Ready to replace SonarQube?
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Paste your repo URL and get a full 102-module scan in under 60 seconds. No server setup,
            no config files, no per-seat pricing. Pay only when results are delivered.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Scan My Repo — From $29
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold border border-white/15 text-white/70 hover:text-white hover:border-white/30 transition-colors"
            >
              See All Features
            </Link>
          </div>
          <p className="text-white/30 text-xs mt-6">
            Card hold only. Charged after successful scan delivery. Released immediately if scan cannot complete.
          </p>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/[0.06] px-6 py-8 mt-16">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex items-center gap-6">
            <Link href="/compare/snyk" className="hover:text-white/60 transition-colors">vs Snyk</Link>
            <Link href="/compare/eslint" className="hover:text-white/60 transition-colors">vs ESLint</Link>
            <Link href="/compare/github-code-scanning" className="hover:text-white/60 transition-colors">vs GitHub Code Scanning</Link>
            <Link href="/compare/deepsource" className="hover:text-white/60 transition-colors">vs DeepSource</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
