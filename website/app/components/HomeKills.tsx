/**
 * <HomeKills> — what GateTest replaces.
 *
 * 12 tool tiles in a grid. Each tile flips on hover (CSS-only, no JS) to
 * show the corresponding GateTest module. Honest copy: "twelve tools, one
 * config, one bill."
 *
 * Pulled from CLAUDE.md "We replace 10+ tools" table. Every module name
 * here matches a real registered module in `src/core/registry.js`.
 *
 * No external CDN dependency — text chips, monospace style.
 */

interface KillTile {
  tool: string;
  module: string;
  blurb: string;
}

const TILES: KillTile[] = [
  { tool: "Snyk", module: "security", blurb: "OWASP + supply chain + CVE database, no SaaS lock-in." },
  { tool: "SonarQube", module: "codeQuality", blurb: "Same rules, no Java daemon, no per-seat seat tax." },
  { tool: "ESLint", module: "lint", blurb: "Plus 90 more checks ESLint never tries to run." },
  { tool: "Cypress", module: "e2e", blurb: "Browser E2E plus 89 things Cypress doesn't do." },
  { tool: "BrowserStack", module: "compatibility", blurb: "Cross-browser matrix, no monthly device farm bill." },
  { tool: "Lighthouse", module: "performance", blurb: "Perf, SEO, A11y unified — and gate-blocking, not advisory." },
  { tool: "axe-core", module: "accessibility", blurb: "WCAG 2.2 AAA — built in, not a separate plugin." },
  { tool: "Renovate", module: "dependencies", blurb: "Polyglot freshness + CVE fix-PR, not just notifications." },
  { tool: "Dependabot", module: "dependencies", blurb: "Same scope, plus typosquats, license risks, lockfile drift." },
  { tool: "hadolint", module: "dockerfile", blurb: "Dockerfile lint + secrets + curl|sh + chmod 777 hunting." },
  { tool: "tfsec", module: "terraform", blurb: "Terraform / Pulumi / CDK security — same gate as everything else." },
  { tool: "actionlint", module: "ciSecurity", blurb: "Plus unpinned actions, pwn-request, permissions hygiene." },
];

export default function HomeKills() {
  return (
    <section id="kills" className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-12">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            What it kills
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Twelve tools. <span className="gradient-text">One config.</span>
            <br className="hidden sm:block" />
            One bill.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Hover any tile to see the GateTest module that replaces it. The
            full table&apos;s in{" "}
            <a href="#kills-table" className="text-accent hover:underline font-medium">
              the breakdown below
            </a>{" "}
            — 30+ tools across the entire QA stack.
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-12">
          {TILES.map((tile) => (
            <KillTileCard key={tile.tool + tile.module} tile={tile} />
          ))}
        </div>

        {/* Full table — text, no animation, dense */}
        <div id="kills-table" className="rounded-2xl border border-border bg-background-alt p-6 sm:p-8">
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
            {[
              ["Jest / Vitest / Mocha", "unitTests"],
              ["Cypress / BrowserStack / Sauce Labs", "e2e"],
              ["ESLint / Stylelint", "lint"],
              ["Snyk / npm audit", "security"],
              ["Renovate / Dependabot", "dependencies"],
              ["hadolint / dockle / docker bench", "dockerfile"],
              ["actionlint / StepSecurity / zizmor", "ciSecurity"],
              ["shellcheck / bashate / shfmt", "shell"],
              ["squawk / gh-ost / pg-osc / Strong Migrations", "sqlMigrations"],
              ["tfsec / Checkov / Terrascan / KICS", "terraform"],
              ["kube-score / kubeaudit / Polaris / Kubesec", "kubernetes"],
              ["Promptfoo / LLM Guard / Lakera / Rebuff", "promptSafety"],
              ["ts-prune / knip / Vulture", "deadCode"],
              ["gitleaks / secretlint / dotenv-linter", "secretRotation"],
              ["securityheaders.com / Mozilla Observatory", "webHeaders"],
              ["type-coverage / @typescript-eslint/no-explicit-any", "typescriptStrictness"],
              ["madge --circular / dependency-cruiser", "importCycle"],
              ["safe-regex / recheck", "redos"],
              ["Lighthouse", "performance"],
              ["axe / pa11y", "accessibility"],
              ["Percy / Chromatic", "visual"],
              ["SonarQube", "codeQuality"],
              ["git-secrets / truffleHog", "secrets"],
              ["broken-link-checker", "links"],
            ].map(([from, to]) => (
              <div key={from + to} className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-b-0">
                <span className="text-muted truncate" title={from}>{from}</span>
                <span className="text-muted/40 shrink-0">&rarr;</span>
                <code className="font-mono text-accent text-xs shrink-0">{to}</code>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted mt-6 pt-6 border-t border-border/40">
            Plus 12 more modules with no direct competitor: AI code review,
            fake-fix detector, mutation testing, chaos / fuzz pass, autonomous
            exploration, live crawling, data integrity, documentation
            validation, compatibility analysis, integration-test detection,
            CI generation, SARIF output.
          </p>
        </div>
      </div>
    </section>
  );
}

function KillTileCard({ tile }: { tile: KillTile }) {
  return (
    <div
      className="group relative h-32 rounded-xl bg-surface-solid border border-border overflow-hidden transition-all hover:border-accent/40 hover:shadow-lg hover:-translate-y-0.5 focus-within:border-accent/40"
      tabIndex={0}
      role="button"
      aria-label={`${tile.tool} is replaced by GateTest module ${tile.module}`}
    >
      {/* Front face — tool name */}
      <div className="absolute inset-0 flex flex-col items-center justify-center p-4 transition-opacity duration-300 group-hover:opacity-0 group-focus-within:opacity-0">
        <div className="text-base font-bold text-foreground tracking-tight">
          {tile.tool}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-muted mt-2">
          We replace this
        </div>
      </div>

      {/* Back face — GateTest module */}
      <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-gradient-to-br from-accent/8 to-accent/3 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100">
        <code className="font-mono text-sm text-accent font-bold">
          --module {tile.module}
        </code>
        <div className="text-xs text-muted text-center mt-2 leading-snug">
          {tile.blurb}
        </div>
      </div>
    </div>
  );
}
