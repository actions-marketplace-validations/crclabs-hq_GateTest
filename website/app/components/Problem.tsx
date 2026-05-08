const oldStack = [
  { name: "SonarQube", price: "$150/mo", job: "Code quality" },
  { name: "Snyk", price: "$98/mo", job: "Security" },
  { name: "Dependabot", price: "$49/mo", job: "Dep upgrades" },
  { name: "ESLint Pro", price: "$29/mo", job: "Linting" },
  { name: "hadolint", price: "Free (CI time)", job: "Dockerfile" },
  { name: "actionlint", price: "Free (CI time)", job: "CI security" },
  { name: "shellcheck", price: "Free (CI time)", job: "Shell scripts" },
  { name: "Lighthouse CI", price: "$49/mo", job: "Performance" },
  { name: "axe / pa11y", price: "$79/mo", job: "Accessibility" },
  { name: "Percy / Chromatic", price: "$199/mo", job: "Visual" },
  { name: "Playwright Cloud", price: "$89/mo", job: "E2E tests" },
  { name: "tfsec / Checkov", price: "$79/mo", job: "IaC security" },
  { name: "Semgrep", price: "$49/mo", job: "SAST patterns" },
];

export default function Problem() {
  const monthlyBurn = 870;

  return (
    <section className="py-24 px-6 border-t border-border/30 bg-[#0a0a12]">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="inline-block px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold uppercase tracking-widest mb-4">
            The Problem
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
            You&apos;re paying{" "}
            <span className="text-red-400">${monthlyBurn}/month</span>
            <br />
            for 13 tools that still miss bugs.
          </h2>
          <p className="text-white/50 text-lg max-w-2xl mx-auto">
            Each tool covers one category. Each has its own config, dashboard, and bill.
            Each has gaps the next tool doesn&apos;t cover. And none of them fix anything.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-start">
          {/* Left: The old stack */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white/40 uppercase tracking-wider">Your current toolchain</h3>
              <span className="text-xs text-red-400 font-mono">${monthlyBurn}/mo · 13 tools · 13 configs</span>
            </div>
            <div className="space-y-2">
              {oldStack.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg bg-red-950/20 border border-red-500/10"
                >
                  <div className="w-2 h-2 rounded-full bg-red-500/50 shrink-0" />
                  <span className="text-white/70 text-sm font-medium flex-1">{tool.name}</span>
                  <span className="text-white/30 text-xs">{tool.job}</span>
                  <span className="text-red-400/70 text-xs font-mono ml-2">{tool.price}</span>
                </div>
              ))}
            </div>

            <div className="mt-4 px-4 py-3 rounded-lg border border-red-500/20 bg-red-950/20">
              <div className="flex items-center justify-between text-sm">
                <span className="text-red-400 font-semibold">Total monthly burn</span>
                <span className="text-red-400 font-mono font-bold text-lg">${monthlyBurn}/mo</span>
              </div>
              <p className="text-white/30 text-xs mt-1">
                Plus CI minutes. Plus engineer time configuring them. Plus bugs they still miss.
              </p>
            </div>
          </div>

          {/* Right: GateTest */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white/40 uppercase tracking-wider">With GateTest</h3>
              <span className="text-xs text-emerald-400 font-mono">$29–$399 · 1 tool · 1 config</span>
            </div>

            <div className="rounded-xl border border-white/10 overflow-hidden bg-white/[0.03]">
              <div className="px-4 py-3 flex items-center gap-2 border-b border-white/6">
                <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <div className="w-3 h-3 rounded-full bg-[#28c840]" />
                <span className="ml-3 text-xs text-white/30 font-mono">gatetest --suite nuclear --fix</span>
              </div>

              <div className="p-5 space-y-2 font-mono text-sm">
                <p className="text-white/40 text-xs">Scanning 90 modules...</p>
                {[
                  { icon: "✓", label: "security", detail: "SSRF + rejectUnauthorized chain — CRITICAL", color: "text-red-400" },
                  { icon: "✓", label: "supplyChain", detail: "3 deps with known CVEs", color: "text-amber-400" },
                  { icon: "✓", label: "moneyFloat", detail: "parseFloat() on trust account — CRITICAL", color: "text-red-400" },
                  { icon: "✓", label: "piiFlow", detail: "user.email → Datadog logs", color: "text-amber-400" },
                  { icon: "✓", label: "importCycle", detail: "A → B → C → A (TDZ risk)", color: "text-amber-400" },
                  { icon: "✓", label: "tlsSecurity", detail: "rejectUnauthorized: false in prod", color: "text-red-400" },
                ].map((r) => (
                  <p key={r.label} className="text-white/60">
                    {"  "}<span className="text-emerald-400">{r.icon}</span>{" "}
                    <span className="text-white/90 font-medium">{r.label}</span>{" "}
                    <span className={r.color}>{r.detail}</span>
                  </p>
                ))}
                <p className="text-white/30 text-xs">{"  "}...84 more modules</p>
                <div className="mt-3 pt-3 border-t border-white/6">
                  <p className="text-emerald-400 font-bold">{"  "}PR OPENED · 18 fixes · 6 regression tests · 14.1s</p>
                  <p className="text-white/25 text-xs mt-1">{"  "}You pay nothing until the PR is delivered.</p>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { value: "90", label: "Modules" },
                { value: "13×", label: "Fewer tools" },
                { value: "$0", label: "If it fails" },
              ].map((s) => (
                <div key={s.label} className="text-center p-3 rounded-lg bg-white/5 border border-white/8">
                  <div className="text-xl font-bold text-white">{s.value}</div>
                  <div className="text-xs text-white/40 mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
