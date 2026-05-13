import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest vs Snyk — Beyond Dependency Scanning in 2026",
  description:
    "Snyk only scans dependencies. GateTest scans your actual code — 90 modules covering security, quality, performance, accessibility, and AI safety. Auto-fixes included.",
  keywords: [
    "Snyk alternative",
    "Snyk vs GateTest",
    "beyond dependency scanning",
    "code security scanning",
    "AI security review",
    "Snyk replacement",
    "source code security",
  ],
  alternates: {
    canonical: "https://gatetest.ai/compare/snyk",
  },
  openGraph: {
    title: "GateTest vs Snyk — Beyond Dependency Scanning in 2026",
    description:
      "Snyk only scans dependencies. GateTest scans your actual code — 90 modules covering security, quality, performance, accessibility, and AI safety.",
    url: "https://gatetest.ai/compare/snyk",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "What does Snyk miss that GateTest catches?",
    a: "Snyk focuses on known CVEs in third-party packages. GateTest scans your actual source code for: SSRF vulnerabilities, N+1 query bugs, race conditions, resource leaks, TLS validation bypasses, PII logged to console, hardcoded localhost URLs, cookie misconfigurations, prompt injection in AI apps, and 50+ more patterns that no dependency scanner can find because they live in code you wrote.",
  },
  {
    q: "Does GateTest also scan dependencies like Snyk?",
    a: "Yes — GateTest includes a polyglot dependency scanner covering npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, and Gradle. It flags wildcard pins, 'latest' dependencies, missing lockfiles, and deprecated packages. Dependency scanning is one module out of 90.",
  },
  {
    q: "How does GateTest pricing compare to Snyk?",
    a: "Snyk charges per developer seat per month — pricing scales with headcount and enterprise contracts can reach thousands monthly. GateTest charges per scan: $99 for all 90 modules. No seat licensing, no annual contracts, no per-developer billing. A 100-person team pays the same per scan as a solo developer.",
  },
  {
    q: "Does GateTest include AI safety and prompt injection scanning like Snyk doesn't?",
    a: "Yes. GateTest's promptSafety module catches: browser-bundled API keys (NEXT_PUBLIC_* / VITE_* with AI keys), OpenAI/Anthropic calls without max_tokens limits (cost DoS vector), user-input interpolation in prompt templates without delimiters (injection surface), and deprecated AI models (claude-v1, text-davinci-*). Snyk has no AI safety coverage.",
  },
  {
    q: "Can GateTest fix vulnerabilities automatically?",
    a: "Yes. The Scan + Fix tier ($199) uses AI to create pull requests with working code changes that address the issues found. Snyk can suggest fix PRs for dependency upgrades in its paid tiers; GateTest auto-fixes source code vulnerabilities — SSRF guards, TLS config fixes, cookie security flags, and more. The Nuclear tier ($399) adds Claude-driven diagnosis on every finding, cross-finding attack-chain correlation, mutation testing, and a CTO-readable executive summary.",
  },
  {
    q: "Does GateTest work with private repos?",
    a: "Yes. GateTest scans private repos via the GitHub App (which you install once and grants scoped read-only access per repo) or via direct GitHub API with a PAT. All scans run server-side — your code is read for scanning and never stored permanently.",
  },
];

const comparisonRows = [
  { feature: "Source code security analysis", gatetest: true, competitor: false },
  { feature: "Dependency / SCA scanning", gatetest: true, competitor: true },
  { feature: "AI code review (finds logic bugs)", gatetest: true, competitor: false },
  { feature: "Auto-fix pull requests for code bugs", gatetest: true, competitor: false },
  { feature: "Prompt injection / AI safety scanning", gatetest: true, competitor: false },
  { feature: "SSRF / URL-validation gap detection", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "TLS validation bypass detection", gatetest: true, competitor: false },
  { feature: "PII-in-logs detection", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat)", gatetest: true, competitor: false },
  { feature: "Known CVE detection in packages", gatetest: true, competitor: true },
  { feature: "PR / commit status integration", gatetest: true, competitor: true },
];

export default function SnykPage() {
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
          <span className="text-white/60">Snyk</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Tool Comparison
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest vs Snyk
            <br />
            <span className="text-teal-400">Beyond Dependency Scanning in 2026</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            Snyk is excellent at finding known CVEs in your package.json. But the most dangerous
            bugs live in code <em>you wrote</em> — SSRF in your API handlers, N+1 queries in your
            loops, race conditions in your auth flows. Snyk can&rsquo;t see any of that.
            GateTest can.
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

        {/* What Snyk misses callout */}
        <section className="mb-16 rounded-xl border border-amber-500/20 p-6" style={{ background: "rgba(245,158,11,0.05)" }}>
          <h2 className="text-lg font-semibold text-amber-300 mb-3">What Snyk can&rsquo;t scan</h2>
          <p className="text-white/60 text-sm mb-4">
            Snyk scans your <code className="text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded text-xs">package.json</code> for known CVEs. It has zero visibility into your application code. These bugs are invisible to Snyk:
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              "SSRF: fetch(req.query.url) with no validation",
              "N+1: await db.find() inside a .map() loop",
              "Race condition: fs.exists() then fs.unlink()",
              "TLS bypass: rejectUnauthorized: false left in production",
              "PII leak: console.log(user) in your auth handler",
              "Prompt injection: template.replace('{input}', userMessage)",
              "Cookie vuln: httpOnly: false on session cookies",
              "ReDoS: (a+)+ regex exposed to user input",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2 text-sm text-white/55">
                <span className="text-red-400/70 shrink-0 mt-0.5">&#10007;</span>
                <code className="text-xs text-white/50">{item}</code>
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
                  <th className="text-center px-5 py-4 text-white/40 font-medium">Snyk</th>
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
          <h2 className="text-2xl font-bold text-white mb-8">Why GateTest goes further</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Source code, not just manifests",
                body: "Snyk reads package.json and compares against CVE databases. GateTest reads your actual TypeScript, JavaScript, Python, and Go — and understands what your code does. That's the difference between 'this library has a known CVE' and 'your API handler passes user input directly to fetch()'.",
              },
              {
                title: "AI safety — the gap Snyk ignores",
                body: "GateTest's promptSafety module catches the new generation of AI app vulnerabilities: browser-exposed API keys, missing max_tokens limits that enable cost DoS attacks, prompt injection surfaces, and deprecated AI models. No other security tool covers this.",
              },
              {
                title: "Auto-fix for source code bugs",
                body: "Snyk can open a PR to bump a dependency version. GateTest writes a fix for the source code bug — adds the SSRF validation guard, removes the TLS bypass, restructures the N+1 query into a batched lookup — and opens the PR for your review.",
              },
              {
                title: "One bill, 90 modules",
                body: "Snyk's seat-based pricing means security costs scale with team size. GateTest is $99 for all 90 modules per scan. Run it daily on a 100-person team or run it once before a major release — the price is the same.",
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
            Scan your code, not just your packages.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Get 90 modules of source code analysis — security, quality, performance, accessibility —
            in one scan. Pay only when results are delivered.
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
            <Link href="/compare/eslint" className="hover:text-white/60 transition-colors">vs ESLint</Link>
            <Link href="/compare/github-code-scanning" className="hover:text-white/60 transition-colors">vs GitHub Code Scanning</Link>
            <Link href="/compare/deepsource" className="hover:text-white/60 transition-colors">vs DeepSource</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
