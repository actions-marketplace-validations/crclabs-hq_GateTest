const steps = [
  {
    step: "01",
    title: "Define your standards",
    description:
      "CLAUDE.md is your single source of truth. Define quality thresholds, checklist items, and gate rules in one human-readable file. GateTest enforces every line automatically.",
    code: `# CLAUDE.md

### Security
- [ ] No hardcoded secrets
- [ ] All dependencies CVE-free
- [ ] CSP headers strict

### Performance
- [ ] LCP < 2.0s
- [ ] Bundle < 200KB gzipped
- [ ] Lighthouse >= 95`,
  },
  {
    step: "02",
    title: "GateTest runs 90 modules",
    description:
      "One command triggers every check — syntax, security, accessibility, supply chain, auth flaws, CI hardening, and 16 more. Every module runs. Every check is recorded.",
    code: `$ gatetest --suite full

[PASS] syntax         — 47 checks
[PASS] lint           — 183 checks
[PASS] secrets        — 312 files scanned
[PASS] security       — 0 vulnerabilities
[PASS] accessibility  — WCAG 2.2 AAA
[PASS] maliciousDeps  — 0 typosquats
[PASS] iacSecurity    — Dockerfiles clean
[PASS] authFlaws      — no JWT/cookie issues
...14 more modules passed`,
  },
  {
    step: "03",
    title: "Gate decides: PASS or BLOCKED",
    description:
      "Zero tolerance. One failure in any of the 90 modules blocks the entire pipeline. No overrides. No \"ship it anyway.\" The gate produces a timestamped report with full evidence.",
    code: `GATE: PASSED

Modules: 67/67 passed
Checks:  847/847 passed
Time:    2.1s

Report saved:
  .gatetest/reports/report-2026-04-05.json
  .gatetest/reports/report-2026-04-05.html

Push allowed. ✓`,
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 px-6 border-t border-border/30">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            How It Works
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            Three steps to <span className="gradient-text">bulletproof quality</span>.
          </h2>
        </div>

        <div className="space-y-16">
          {steps.map((step, index) => (
            <div
              key={step.step}
              className={`grid lg:grid-cols-2 gap-10 items-center ${
                index % 2 === 1 ? "" : ""
              }`}
            >
              <div className={index % 2 === 1 ? "lg:order-2" : ""}>
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center font-[var(--font-mono)] text-sm text-accent-light font-bold">
                    {step.step}
                  </span>
                  <h3 className="text-xl font-bold">{step.title}</h3>
                </div>
                <p className="text-muted leading-relaxed">{step.description}</p>
              </div>

              <div className={`terminal ${index % 2 === 1 ? "lg:order-1" : ""}`}>
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                </div>
                <pre className="p-5 font-[var(--font-mono)] text-sm text-muted overflow-x-auto leading-relaxed">
                  {step.code}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
