export default function Cta() {
  return (
    <section id="get-started" className="py-24 px-6 border-t border-border/30 grid-bg relative">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <h2 className="text-3xl sm:text-5xl font-bold mb-6">
          Stop shipping <span className="text-danger">broken code</span>.
        </h2>
        <p className="text-lg text-muted mb-4 max-w-xl mx-auto">
          Point us at your repo. We scan 90 modules, find every issue, and fix what we can.
          You only pay when the scan delivers.
        </p>
        <p className="text-sm text-success mb-10">
          Card hold only &mdash; released if scan cannot complete. Zero risk.
        </p>

        {/* Two paths */}
        <div className="grid sm:grid-cols-2 gap-5 max-w-2xl mx-auto mb-10">
          {/* Paid scan */}
          <div className="terminal">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-muted">We scan it for you</span>
            </div>
            <div className="p-5 text-left">
              <p className="text-sm font-bold text-foreground mb-2">Full Scan &mdash; $99</p>
              <p className="text-xs text-muted mb-3">
                90 modules. Full report. Auto-fix PR lands in your repo.
              </p>
              <a
                href="#pricing"
                className="block text-center py-3 px-5 rounded-lg font-semibold text-sm bg-accent hover:bg-accent-light text-white transition-colors"
              >
                Scan My Repo
              </a>
            </div>
          </div>

          {/* Free CLI */}
          <div className="terminal">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-muted">Run it yourself</span>
            </div>
            <div className="p-5 font-[var(--font-mono)] text-sm text-left">
              <p className="text-muted">
                <span className="text-accent-light">$</span> npm install -g gatetest
              </p>
              <p className="text-muted">
                <span className="text-accent-light">$</span> gatetest --suite full --fix
              </p>
              <p className="text-success mt-3 font-bold">GATE: PASSED</p>
              <p className="text-xs text-muted mt-2">Free forever. All 90 modules.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href="#pricing"
            className="px-8 py-4 text-base font-semibold rounded-xl bg-accent hover:bg-accent-light text-white transition-all pulse-glow"
          >
            See All Pricing
          </a>
          <a
            href="https://github.com/ccantynz-alt/GateTest"
            target="_blank"
            rel="noopener noreferrer"
            className="px-8 py-4 text-base font-semibold rounded-xl border border-border hover:border-accent/50 text-foreground transition-all"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
