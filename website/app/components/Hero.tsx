import WebsiteCheckerInput from "./WebsiteCheckerInput";

export default function Hero() {
  return (
    <section className="relative overflow-hidden bg-[#0a0a12]">
      {/* Glow layers */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] bg-gradient-to-b from-teal-500/10 to-transparent rounded-full blur-[160px] pointer-events-none" />
      <div className="absolute top-32 left-0 w-[500px] h-[400px] bg-gradient-to-r from-violet-600/6 to-transparent rounded-full blur-[130px] pointer-events-none" />
      <div className="absolute top-32 right-0 w-[500px] h-[400px] bg-gradient-to-l from-blue-600/6 to-transparent rounded-full blur-[130px] pointer-events-none" />
      <div className="hero-grid" aria-hidden="true" />

      {/* Pre-launch notice — below navbar, not above it */}
      <div className="relative z-10 pt-[72px]">
        <div className="text-center py-2 text-xs text-amber-400/80 border-b border-white/5 bg-amber-500/5">
          <span className="font-semibold tracking-wide uppercase mr-1">Pre-launch</span>
          — GateTest is in final validation. Public scans open very soon.
        </div>
      </div>

      {/* Main hero — two column on large, stacked on mobile */}
      <div className="relative z-10 mx-auto max-w-7xl px-6 pt-16 pb-24 grid lg:grid-cols-2 gap-12 items-center">

        {/* ── LEFT: copy ── */}
        <div>
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-white/60 font-medium mb-8">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
            </span>
            92 modules &middot; Claude Opus 4.7 &middot; Pay only when delivered
          </div>

          {/* Headline */}
          <h1 className="text-4xl sm:text-5xl xl:text-[60px] font-bold tracking-tight leading-[1.08] text-white mb-5">
            Fix every bug
            <br />
            <span className="text-[#2dd4bf]">before it ships.</span>
          </h1>

          {/* Subheadline */}
          <p className="text-base sm:text-lg text-white/50 leading-relaxed mb-4 max-w-lg">
            GateTest scans 92 modules — security, supply chain, async bugs,
            money-float precision, PII leaks — then Claude Opus 4.7 reasons through
            every finding and opens the fix PR.{" "}
            <strong className="text-white/75 font-semibold">You pay only when delivered.</strong>
          </p>

          {/* Competitor kill */}
          <p className="text-xs text-white/30 mb-10">
            Replaces SonarQube · Snyk · ESLint Pro · Dependabot · hadolint · actionlint · shellcheck · and 6 more
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row gap-3 mb-12">
            <a
              href="#pricing"
              className="hero-cta px-8 py-3.5 text-sm rounded-xl font-semibold text-center"
            >
              Fix My Code — From $29
            </a>
            <a
              href="/fixes"
              className="px-7 py-3.5 text-sm font-semibold text-white/55 border border-white/12 rounded-xl hover:text-white hover:border-white/25 transition-colors text-center"
            >
              See Real PRs Delivered →
            </a>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { value: "92", label: "Modules" },
              { value: "800+", label: "Checks" },
              { value: "Opus 4.7", label: "AI Model" },
              { value: "$0", label: "If Scan Fails" },
            ].map((s) => (
              <div key={s.label} className="text-center px-3 py-3 rounded-xl bg-white/4 border border-white/7">
                <div className="text-xl font-bold text-white">{s.value}</div>
                <div className="text-xs text-white/35 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Website checker — for non-technical users */}
          <div className="mt-8 pt-6 border-t border-white/6">
            <p className="text-xs text-white/35 mb-3">
              No GitHub account? Check any live website for free:
            </p>
            <WebsiteCheckerInput />
          </div>
        </div>

        {/* ── RIGHT: terminal ── */}
        <div className="relative">
          <div className="relative rounded-2xl border border-white/10 overflow-hidden shadow-2xl bg-white/[0.03]">
            {/* Title bar */}
            <div className="px-4 py-3 flex items-center gap-2 border-b border-white/6 bg-white/[0.02]">
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-xs text-white/30 font-[var(--font-mono)]">
                gatetest --suite nuclear --fix
              </span>
              <span className="ml-auto text-[10px] text-rose-400 font-bold tracking-widest">NUCLEAR</span>
            </div>

            {/* Scan line animation */}
            <span className="terminal-scan-line" aria-hidden="true" />

            {/* Terminal body */}
            <div className="p-5 font-[var(--font-mono)] text-sm text-left space-y-1.5 leading-relaxed">
              <p className="text-rose-400 font-bold text-[11px] tracking-widest">
                GATETEST NUCLEAR — Claude Opus 4.7 · Adaptive Thinking
              </p>
              <p className="text-white/25 text-[11px]">
                92 modules · github.com/acme/payments-api
              </p>

              <div className="my-3 border-t border-white/5" />

              <p>
                <span className="text-emerald-400">✓</span>{" "}
                <span className="text-white/90 font-medium">moneyFloat</span>{" "}
                <span className="text-red-400 text-[12px]">parseFloat(price) — trust-account drift</span>
              </p>
              <p>
                <span className="text-emerald-400">✓</span>{" "}
                <span className="text-white/90 font-medium">logPii</span>{" "}
                <span className="text-red-400 text-[12px]">user.email → Datadog logs (GDPR Art.5)</span>
              </p>
              <p>
                <span className="text-emerald-400">✓</span>{" "}
                <span className="text-white/90 font-medium">ssrf</span>{" "}
                <span className="text-amber-400 text-[12px]">req.body.url → fetch() unvalidated</span>
              </p>
              <p>
                <span className="text-emerald-400">✓</span>{" "}
                <span className="text-white/90 font-medium">tlsSecurity</span>{" "}
                <span className="text-red-400 text-[12px]">cert validation bypassed in prod</span>
              </p>
              <p>
                <span className="text-emerald-400">✓</span>{" "}
                <span className="text-white/90 font-medium">cveFeed</span>{" "}
                <span className="text-amber-400 text-[12px]">lodash@4.17.20 — CVE-2021-23337 (CVSS 7.2)</span>
              </p>
              <p className="text-white/25 text-[11px]">  ...87 more modules</p>

              <div className="my-3 border-t border-white/5" />

              <p className="text-violet-300 text-[12px]">
                🧠 &quot;moneyFloat + ssrf chain — untrusted decimal in downstream webhook&quot;
              </p>
              <p className="text-white/20 text-[11px]">
                attack-chain: payment-integrity × data-exfil → CRITICAL
              </p>

              <div className="my-3 border-t border-white/5" />

              <p className="text-emerald-400 font-bold text-[13px]">
                PR OPENED{" "}
                <span className="text-white/35 font-normal text-[11px]">
                  · 12 fixes · 4 regression tests · 11.2s
                </span>
              </p>
              <p className="text-white/20 text-[11px]">
                branch: gatetest/nuclear-fix · mutation gate: passed
              </p>
            </div>
          </div>

          {/* Floating label */}
          <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-semibold whitespace-nowrap">
            PR delivered · payment captured
          </div>
        </div>
      </div>
    </section>
  );
}
