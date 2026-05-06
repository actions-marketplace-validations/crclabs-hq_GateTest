export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-20">
      {/* Dark hero block */}
      <div className="hero-dark px-6 pb-32 pt-16 relative">
        {/* Animated grid pattern */}
        <div className="hero-grid" aria-hidden="true" />
        {/* Multi-layer glow — teal centre + purple left + blue right */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-gradient-to-b from-teal-500/12 to-transparent rounded-full blur-[140px] pointer-events-none" />
        <div className="absolute top-20 left-0 w-[400px] h-[300px] bg-gradient-to-r from-violet-500/8 to-transparent rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute top-20 right-0 w-[400px] h-[300px] bg-gradient-to-l from-blue-500/8 to-transparent rounded-full blur-[120px] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-6xl text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm text-white/70 font-medium mb-10 fade-up">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            90 modules &middot; Claude Opus 4.7 &middot; Pay only when delivered
          </div>

          {/* Headline */}
          <h1 className="text-5xl sm:text-6xl lg:text-[80px] font-bold tracking-tight leading-[1.05] mb-6 fade-up text-white">
            The only QA tool that
            <br />
            <span className="hero-accent-text">thinks, fixes and proves it.</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-white/55 max-w-2xl mx-auto mb-4 leading-relaxed fade-up">
            GateTest scans 90 modules — security, supply chain, async bugs, money-float precision,
            circular imports, PII leaks — then Claude Opus 4.7 reasons through every bug with
            adaptive thinking and opens the fix PR.{" "}
            <strong className="text-white/80">You only pay when the PR is delivered.</strong>
          </p>

          {/* Competitor kill line */}
          <p className="text-sm text-white/35 mb-10 fade-up">
            Replaces SonarQube &bull; Snyk &bull; ESLint Pro &bull; Dependabot &bull; hadolint &bull; actionlint &bull; shellcheck &bull; and 6 more tools — in one scan.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 fade-up">
            <a href="#pricing" className="hero-cta px-10 py-4 text-base rounded-xl font-semibold">
              Fix My Code — From $29
            </a>
            <a href="/fixes" className="px-8 py-4 text-base font-semibold text-white/60 border border-white/15 rounded-xl hover:text-white hover:border-white/30 transition-colors">
              See Real PRs Delivered →
            </a>
          </div>

          {/* Terminal — cinematic, shows thinking + fix */}
          <div className="relative max-w-3xl mx-auto rounded-xl border border-white/10 overflow-hidden shadow-2xl fade-up bg-white/[0.03]">
            <div className="px-4 py-3 flex items-center gap-2 border-b border-white/6">
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-xs text-white/30 font-[var(--font-mono)]">gatetest --suite nuclear --fix</span>
              <span className="ml-auto text-xs text-rose-400 font-medium tracking-wider">NUCLEAR</span>
            </div>
            <span className="terminal-scan-line" aria-hidden="true" />
            <div className="relative p-6 font-[var(--font-mono)] text-sm text-left space-y-1.5 leading-relaxed">
              <p className="text-rose-400 font-bold text-xs tracking-wider">GATETEST NUCLEAR &mdash; Claude Opus 4.7 · Adaptive Thinking · effort:xhigh</p>
              <p className="text-white/30 text-xs">90 modules · github.com/acme/payments-api · thinking enabled</p>
              <p className="mt-2" />
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">moneyFloat</span> <span className="text-red-400">parseFloat(price) — trust-account drift risk</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">piiFlow</span> <span className="text-red-400">user.email → Datadog logs (GDPR Article 5)</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">ssrf</span> <span className="text-amber-400">req.body.url → fetch() — no validation</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">tlsSecurity</span> <span className="text-red-400">rejectUnauthorized: false in prod path</span></p>
              <p className="text-white/50 text-xs">{"  "}...86 more modules</p>
              <p className="mt-2" />
              <p className="text-violet-300 text-xs">{"  "}🧠 Claude reasoning: &quot;moneyFloat + ssrf chain — untrusted decimal in downstream webhook call...&quot;</p>
              <p className="text-white/25 text-xs">{"  "}attack-chain: payment-integrity × data-exfil → CRITICAL</p>
              <p className="mt-2" />
              <p className="text-emerald-400 font-bold">{"  "}PR OPENED <span className="text-white/40 font-normal">· 12 fixes · 4 regression tests · 1 property test · 11.2s</span></p>
              <p className="text-white/25 text-xs">{"  "}branch: gatetest/nuclear-fix · mutation gate: passed · syntax gate: passed</p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-14 max-w-2xl mx-auto fade-up stagger">
            {[
              { value: "90", label: "Scan Modules" },
              { value: "800+", label: "Quality Checks" },
              { value: "Opus 4.7", label: "AI Model" },
              { value: "$0", label: "If Scan Fails" },
            ].map((stat) => (
              <div key={stat.label} className="text-center p-4 rounded-xl bg-white/5 border border-white/8">
                <div className="text-2xl font-bold text-white">{stat.value}</div>
                <div className="text-sm text-white/40 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
