export default function Problem() {
  const tools = [
    { name: "Jest", category: "Unit Tests" },
    { name: "Cypress", category: "E2E" },
    { name: "ESLint", category: "Linting" },
    { name: "Snyk", category: "Security" },
    { name: "Lighthouse", category: "Performance" },
    { name: "axe", category: "Accessibility" },
    { name: "Percy", category: "Visual" },
    { name: "git-secrets", category: "Secrets" },
    { name: "Stylelint", category: "CSS" },
    { name: "broken-link-checker", category: "Links" },
  ];

  return (
    <section className="py-24 px-6 border-t border-border/30">
      <div className="mx-auto max-w-6xl">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left: The problem */}
          <div>
            <span className="text-sm font-semibold text-danger uppercase tracking-wider">
              The Problem
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-6">
              Your testing stack is a
              <span className="text-danger"> mess</span>.
            </h2>
            <p className="text-muted text-lg leading-relaxed mb-8">
              Right now you&apos;re duct-taping 10 separate tools together.
              Different configs. Different dashboards. Different billing.
              Different teams managing each one. Things slip through the cracks.
              Every single day.
            </p>

            <div className="flex flex-wrap gap-2">
              {tools.map((tool) => (
                <div
                  key={tool.name}
                  className="px-3 py-1.5 rounded-lg bg-danger/5 border border-danger/20 text-sm text-danger/80"
                >
                  {tool.name} <span className="text-danger/40">({tool.category})</span>
                </div>
              ))}
            </div>

            <p className="text-muted text-sm mt-6">
              10 tools. 10 configs. 10 points of failure. 10 things to maintain.
            </p>
          </div>

          {/* Right: The solution */}
          <div>
            <span className="text-sm font-semibold text-success uppercase tracking-wider">
              The Solution
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-6">
              One gate.
              <span className="text-success"> One decision.</span>
            </h2>
            <p className="text-muted text-lg leading-relaxed mb-8">
              GateTest replaces your entire testing toolchain with a single unified
              system. One config file. One command. One report. PASS or BLOCKED.
              That&apos;s it.
            </p>

            <div className="glow-border rounded-xl p-6 bg-surface">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-3 h-3 rounded-full bg-success animate-pulse" />
                <span className="font-[var(--font-mono)] text-sm text-success">gatetest --suite full</span>
              </div>
              <div className="space-y-2 font-[var(--font-mono)] text-sm">
                <p className="text-muted">90 modules. 800+ checks. One gate.</p>
                <p className="text-success font-bold text-lg mt-3">GATE: PASSED</p>
              </div>
            </div>

            <p className="text-muted text-sm mt-6">
              1 tool. 1 config. 0 points of failure. Ships.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
