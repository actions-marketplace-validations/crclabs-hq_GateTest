const activeModules = [
  {
    name: "Syntax",
    description: "Validates JS, TS, JSON, YAML, CSS, HTML. Catches broken imports and unclosed brackets.",
    icon: "{ }",
  },
  {
    name: "Lint",
    description: "ESLint, Stylelint checks. Catches var usage, formatting issues, style violations.",
    icon: "~",
  },
  {
    name: "Secrets",
    description: "14 patterns: AWS keys, GitHub tokens, Stripe keys, passwords, private keys, DB strings.",
    icon: "!",
  },
  {
    name: "Code Quality",
    description: "Catches console.log, debugger, TODO/FIXME, eval(), function complexity.",
    icon: "Q",
  },
  {
    name: "Security",
    description: "OWASP patterns, XSS, SQL injection, innerHTML, shell exec, Docker misconfigs.",
    icon: "S",
  },
  {
    name: "Accessibility",
    description: "WCAG 2.2 AAA — missing alt text, ARIA labels, keyboard traps, heading hierarchy.",
    icon: "A",
  },
  {
    name: "SEO",
    description: "Meta tags, Open Graph, structured data, robots.txt, canonical URLs.",
    icon: "O",
  },
  {
    name: "Links",
    description: "Finds every broken href — dead anchors, placeholder links, 404s.",
    icon: "L",
  },
  {
    name: "Compatibility",
    description: "Browser matrix validation. Modern API and CSS features without polyfills.",
    icon: "C",
  },
  {
    name: "Data Integrity",
    description: "Migration safety, SQL injection patterns, PII in logs, database schema validation.",
    icon: "D",
  },
  {
    name: "Documentation",
    description: "README, CHANGELOG, LICENSE, JSDoc coverage, env documentation.",
    icon: "R",
  },
  {
    name: "Performance",
    description: "Dependency count, bundle size analysis, image optimisation checks.",
    icon: "P",
  },
  {
    name: "AI Code Review",
    description: "Claude AI reads your code and finds real bugs — not patterns, actual understanding.",
    icon: "AI",
  },
  {
    name: "Fake-Fix Detector",
    description: "Catches AI-generated symptom patches — skipped tests, swallowed errors, dead code.",
    icon: "FF",
  },
  {
    name: "Dependency Freshness",
    description: "CVE scan + staleness check on every package.json dependency via OSV.dev + npm.",
    icon: "DF",
  },
  {
    name: "Supply Chain",
    description: "Typosquat detection against top npm packages. Lifecycle script audit for malicious payloads.",
    icon: "SC",
  },
  {
    name: "License Compliance",
    description: "Per-dependency license lookup. Flags GPL, AGPL, SSPL — copyleft risks for SaaS.",
    icon: "LC",
  },
  {
    name: "IaC Security",
    description: "Dockerfiles, Kubernetes manifests, Terraform — :latest tags, privileged mode, 0.0.0.0/0.",
    icon: "IC",
  },
  {
    name: "CI/CD Hardening",
    description: "GitHub Actions audit — unpinned actions, pull_request_target, missing permissions.",
    icon: "CI",
  },
  {
    name: "Migration Safety",
    description: "SQL migration files — DROP COLUMN, non-concurrent indexes, DELETE without WHERE.",
    icon: "MS",
  },
  {
    name: "Auth Flaws",
    description: "JWT alg:none, bcrypt rounds < 10, httpOnly:false, hardcoded session secrets.",
    icon: "AF",
  },
  {
    name: "Flaky Tests",
    description: "Catches .only/.skip leaks, setTimeout in tests, Math.random without seeds, missing await.",
    icon: "FT",
  },
];

export default function Modules() {
  return (
    <section id="modules" className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            What We Check
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            90 modules. <span className="gradient-text">Every scan.</span>
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Source code analysis, AI review, infrastructure hardening, supply chain,
            and 9 language backends. Every module runs on every Full Scan. No
            configuration needed.
          </p>
        </div>

        {/* Active modules */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-16">
          {activeModules.map((mod) => (
            <div
              key={mod.name}
              className="card p-5"
            >
              <div className="w-10 h-10 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center font-[var(--font-mono)] font-bold text-accent text-sm mb-3">
                {mod.icon}
              </div>
              <h3 className="font-semibold text-foreground mb-1">{mod.name}</h3>
              <p className="text-sm text-muted leading-relaxed">{mod.description}</p>
            </div>
          ))}
        </div>

        {/* Coming Soon */}
        <div className="text-center mb-8">
          <span className="text-sm font-semibold text-muted uppercase tracking-wider">
            Coming Soon
          </span>
          <h3 className="text-2xl font-bold mt-3 mb-2 text-foreground">
            More modules in development
          </h3>
          <p className="text-muted max-w-xl mx-auto">
            Live browser testing, visual regression, auto-fix PRs, and mutation testing.
            Powered by real browser automation.
          </p>
        </div>


      </div>
    </section>
  );
}
