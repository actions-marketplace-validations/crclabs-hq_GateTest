export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-20">
      {/* Dark hero block */}
      <div className="hero-dark px-6 pb-24 pt-16 relative">
        {/* Animated grid pattern */}
        <div className="hero-grid" aria-hidden="true" />
        {/* Subtle gradient accent */}
        <div className="hidden md:block absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-gradient-to-b from-teal-500/8 to-transparent rounded-full blur-[100px] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-5xl text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm text-white/70 font-medium mb-10 fade-up">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            22 Modules &middot; AI-Powered &middot; Pay Only When Delivered
          </div>

          {/* Headline */}
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.08] mb-6 fade-up text-white">
            Your code has problems.
            <br />
            <span className="hero-accent-text">We find and fix them.</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-white/50 max-w-2xl mx-auto mb-12 leading-relaxed fade-up">
            67 modules scan your entire codebase. Security, supply chain,
            auth flaws, CI hardening, and more. AI-powered review finds real
            bugs &mdash; then auto-fixes them. You only pay when it&apos;s delivered.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 fade-up">
            <a href="#pricing" className="hero-cta px-8 py-4 text-base rounded-xl font-semibold">
              Scan My Repo &mdash; From $29
            </a>
            <a href="#how-it-works" className="px-8 py-4 text-base font-semibold text-white/60 border border-white/15 rounded-xl hover:text-white hover:border-white/30 transition-colors">
              See How It Works
            </a>
          </div>

          {/* Terminal — belongs here, dark on dark */}
          <div className="relative max-w-3xl mx-auto rounded-xl border border-white/10 overflow-hidden shadow-2xl fade-up bg-white/[0.03]">
            <div className="px-4 py-3 flex items-center gap-2 border-b border-white/6">
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-xs text-white/30 font-[var(--font-mono)]">gatetest --suite full --fix</span>
              <span className="ml-auto text-xs text-emerald-400 font-medium tracking-wider">LIVE</span>
            </div>
            <span className="terminal-scan-line" aria-hidden="true" />
            <div className="relative p-6 font-[var(--font-mono)] text-sm text-left space-y-1.5 leading-relaxed">
              <p className="text-emerald-400 font-bold text-xs tracking-wider">GATETEST &mdash; Quality Assurance Gate</p>
              <p className="text-white/30 text-xs">Running full suite: 67 modules</p>
              <p className="mt-3" />
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">syntax</span> <span className="text-white/30">&mdash; 47 checks, 12ms</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">secrets</span> <span className="text-white/30">&mdash; 312 files, 0 found</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">security</span> <span className="text-white/30">&mdash; 0 vulns, OWASP clean</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">accessibility</span> <span className="text-white/30">&mdash; WCAG 2.2 AAA</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">performance</span> <span className="text-white/30">&mdash; 98/100, LCP 1.1s</span></p>
              <p className="text-white/70">{"  "}<span className="text-emerald-400">&#10003;</span> <span className="text-white/90 font-medium">aiReview</span> <span className="text-white/30">&mdash; Claude: 2 bugs found, 2 fixed</span></p>
              <p className="text-white/25 text-xs">{"  "}...61 more modules passed</p>
              <p className="mt-3" />
              <p className="text-emerald-400 font-bold">{"  "}GATE: PASSED <span className="text-white/40 font-normal">&mdash; 67/67 modules, 800+ checks, 3.1s</span></p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-14 max-w-2xl mx-auto fade-up stagger">
            {[
              { value: "67", label: "Test Modules" },
              { value: "800+", label: "Quality Checks" },
              { value: "$0", label: "If Scan Fails" },
              { value: "0", label: "Tolerance for Bugs" },
            ].map((stat) => (
              <div key={stat.label} className="text-center p-4 rounded-xl bg-white/5 border border-white/8">
                <div className="text-3xl font-bold text-white">{stat.value}</div>
                <div className="text-sm text-white/40 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
