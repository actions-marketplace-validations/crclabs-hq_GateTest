const competitors = [
  { name: "Cypress", categories: 1, scope: "Browser E2E only" },
  { name: "Jest", categories: 1, scope: "Unit tests only" },
  { name: "ESLint", categories: 1, scope: "Linting only" },
  { name: "Lighthouse", categories: 4, scope: "Perf + SEO + A11y + Best Practices" },
  { name: "Snyk", categories: 1, scope: "Security scanning only" },
  { name: "Percy", categories: 1, scope: "Visual regression only" },
  { name: "axe", categories: 1, scope: "Accessibility only" },
  { name: "SonarQube", categories: 3, scope: "Code quality + some security" },
];

const features = [
  "Syntax validation",
  "Linting",
  "Secret detection",
  "Code quality",
  "Unit tests",
  "Integration tests",
  "E2E tests",
  "Visual regression",
  "Accessibility (AAA)",
  "Performance / Vitals",
  "Security / OWASP",
  "SEO & metadata",
  "Broken links",
  "Browser compat",
  "Data integrity",
  "Documentation",
];

export default function Comparison() {
  return (
    <section id="comparison" className="py-24 px-6 border-t border-border/30">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            Competitive Analysis
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            They test <span className="text-muted">one thing</span>.{" "}
            We test <span className="gradient-text">everything</span>.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            No single competitor covers more than 4 categories. GateTest covers 16.
            That&apos;s not incremental improvement — it&apos;s a different product category.
          </p>
        </div>

        {/* Competitor bars */}
        <div className="space-y-3 mb-16">
          {competitors.map((comp) => (
            <div key={comp.name} className="flex items-center gap-4">
              <div className="w-28 text-sm text-muted text-right shrink-0">{comp.name}</div>
              <div className="flex-1 relative">
                <div className="h-8 rounded-md bg-surface border border-border/50 overflow-hidden">
                  <div
                    className="h-full bg-muted/20 rounded-md flex items-center px-3"
                    style={{ width: `${(comp.categories / 16) * 100}%`, minWidth: '80px' }}
                  >
                    <span className="text-xs text-muted whitespace-nowrap">
                      {comp.categories}/16 — {comp.scope}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* GateTest row */}
          <div className="flex items-center gap-4">
            <div className="w-28 text-sm text-accent-light text-right shrink-0 font-bold">GateTest</div>
            <div className="flex-1 relative">
              <div className="h-10 rounded-md glow-border overflow-hidden">
                <div className="h-full bg-accent/20 rounded-md flex items-center px-3 w-full">
                  <span className="text-sm text-accent-light font-semibold">
                    102/102 — Everything. All of it. One gate.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Feature checklist */}
        <div className="glow-border rounded-xl p-8 bg-surface">
          <h3 className="font-bold text-lg mb-6 text-center">What&apos;s included in every GateTest run</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {features.map((feature) => (
              <div key={feature} className="flex items-center gap-2 text-sm">
                <span className="text-success text-lg">&#10003;</span>
                <span className="text-foreground">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
