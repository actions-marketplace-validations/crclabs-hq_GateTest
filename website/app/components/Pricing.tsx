"use client";

import { useState } from "react";

const scanPlans = [
  {
    id: "quick",
    name: "Quick Scan",
    price: "$29",
    period: "per scan",
    description:
      "Essential checks. Syntax, linting, secrets, and code quality.",
    modules: "4 modules",
    features: [
      "Syntax & compilation validation",
      "Linting checks",
      "Secret & credential detection",
      "Code quality analysis",
      "Detailed report with file & line numbers",
      "AI auto-fix PR included",
      "Pay only when scan completes",
    ],
    cta: "Run Quick Scan",
    highlight: false,
  },
  {
    id: "full",
    name: "Full Scan",
    price: "$99",
    period: "per scan",
    badge: "Most Popular",
    description:
      "Every module. Security, accessibility, SEO, AI code review, and more.",
    modules: "All 90 modules",
    features: [
      "Everything in Quick Scan",
      "Security (OWASP, XSS, SQLi, SSRF, ReDoS, TLS, cookies)",
      "Accessibility (WCAG 2.2 AAA)",
      "Supply chain — typosquats + license compliance",
      "IaC security — Dockerfile, K8s, Terraform",
      "CI/CD hardening — unpinned actions, permissions",
      "Auth flaws — JWT, bcrypt, cookies",
      "Migration safety — dangerous SQL patterns",
      "Flaky test detector",
      "AI code review by Claude Opus 4.7 with adaptive thinking",
      "AI auto-fix PR — Claude opens a PR with the fixes",
    ],
    cta: "Run Full Scan",
    highlight: true,
  },
  {
    id: "scan_fix",
    name: "Scan + Fix",
    price: "$199",
    period: "per scan",
    badge: "Deepest review",
    description:
      "Full Scan plus a second-Claude pair-review on every fix and a codebase-shape architecture report.",
    modules: "All 90 + depth review",
    features: [
      "Everything in Full Scan",
      "Pair-review critique on every fix — second Claude scores correctness, completeness, readability, test coverage",
      "Architecture annotator — design observations on codebase shape (layering, duplication, god objects)",
      "Both reports posted as separate PR comments",
      "Iterative fix loop with N retries — Claude learns from its own failed attempts",
      "Cross-file syntax + scanner gates — broken fixes never ship",
      "Regression test for every fix — your suite gets stronger when you merge",
    ],
    cta: "Run Scan + Fix",
    highlight: false,
  },
  {
    id: "nuclear",
    name: "Nuclear",
    price: "$399",
    period: "per scan",
    badge: "Maximum depth",
    description:
      "The deepest scan we offer. Real Claude diagnosis, attack-chain correlation, mutation testing, chaos pass, executive summary.",
    modules: "All 90 + nuclear stack",
    features: [
      "Everything in Scan + Fix",
      "Real Claude diagnosis on every finding — no templated snippets, every fix reasoned from your specific evidence",
      "Cross-finding attack-chain correlation — textbook session-forgery / supply-chain / rotation-impossible vectors that per-finding scanners can never see",
      "Mutation testing — we mutate your source under your tests, prove your tests actually catch bugs",
      "Chaos / fuzz pass — adversarial inputs against HTTP routes, CLI args, file parsers; report what crashes",
      "CTO-readable executive summary — single document, plain language, real recommendations",
      "Best margin if you're shipping money or PII — the $399 hits all the high-stakes bug classes",
    ],
    cta: "Run Nuclear",
    highlight: false,
  },
];

const continuousPlans = [
  {
    id: "continuous_quick",
    name: "Continuous Quick",
    price: "$49",
    period: "/mo",
    description: "Automated gate on every push. Quick suite blocks merges on errors.",
    modules: "4 modules · every push",
    features: [
      "Scan triggered on every git push",
      "Syntax, linting, secrets, code quality",
      "GitHub commit status — pass / fail on every PR",
      "Merge blocked on any error-level finding",
      "Monthly billing — cancel any time",
    ],
    cta: "Start Continuous Quick",
    highlight: false,
  },
  {
    id: "continuous_full",
    name: "Continuous Full",
    price: "$149",
    period: "/mo",
    badge: "Best value",
    description: "All 90 modules on every push. Replaces ESLint Pro + SonarQube + Snyk (~$400+/mo stack) for one flat fee.",
    modules: "All 90 modules · every push",
    features: [
      "Everything in Continuous Quick",
      "All 90 modules on every push",
      "AI auto-fix PR opened automatically on failure",
      "Adaptive thinking repair — Opus 4.7 reasons through every bug",
      "Security, supply chain, IaC, CI hardening on every commit",
      "Replaces ESLint Pro + SonarQube + Snyk for ~$250/mo less",
    ],
    cta: "Start Continuous Full",
    highlight: true,
  },
  {
    id: "continuous_nuclear",
    name: "Continuous Nuclear",
    price: "$299",
    period: "/mo",
    description: "Full Nuclear stack automated on every push — diagnosis, chains, mutation, executive summary per run.",
    modules: "All 90 + nuclear · every push",
    features: [
      "Everything in Continuous Full",
      "Claude diagnosis on every finding — every push",
      "Attack-chain correlation on every push",
      "Mutation testing per run",
      "Executive summary report per run",
      "CISO-ready PDF on demand",
    ],
    cta: "Start Continuous Nuclear",
    highlight: false,
  },
];

export default function Pricing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"onetime" | "continuous">("onetime");

  async function handleCheckout(tierId: string) {
    if (!repoUrl || !(repoUrl.includes("github.com") || repoUrl.includes("gluecron.com"))) {
      setError("Please enter a valid GitHub or Gluecron repository URL above");
      const input = document.getElementById("repo-url");
      if (input) {
        input.scrollIntoView({ behavior: "smooth", block: "center" });
        input.focus();
      }
      return;
    }

    setLoading(tierId);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: tierId, repoUrl }),
      });

      const data = await res.json();

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        setError(data.error || "Checkout is not available right now. Please try again shortly.");
      }
    } catch {
      setError("Could not reach checkout. Please try again shortly.");
    } finally {
      setLoading(null);
    }
  }

  const activePlans = tab === "onetime" ? scanPlans : continuousPlans;

  return (
    <section id="pricing" className="py-24 px-6 section-accent">
      <div className="relative z-10 mx-auto max-w-5xl">
        <div className="text-center mb-6">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            Pricing
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Pay when it&apos;s done. <span className="gradient-text">Not before.</span>
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            One-time scans or continuous scanning on every push.
            Card held until delivery — no charge if we can&apos;t complete it.
          </p>
        </div>

        {/* Tab selector */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex rounded-xl border border-border bg-surface-dark p-1 gap-1">
            <button
              onClick={() => setTab("onetime")}
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${
                tab === "onetime"
                  ? "bg-accent text-black"
                  : "text-muted hover:text-foreground"
              }`}
            >
              One-time scans
            </button>
            <button
              onClick={() => setTab("continuous")}
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${
                tab === "continuous"
                  ? "bg-accent text-black"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Continuous · monthly
            </button>
          </div>
        </div>

        {tab === "continuous" && (
          <div className="flex justify-center mb-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Scan triggered on every push · GitHub App required · cancel any time
            </div>
          </div>
        )}

        {tab === "onetime" && (
          <div className="flex justify-center mb-6">
            <div className="inline-flex items-center gap-2 badge-accent px-5 py-2 text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Card hold only &mdash; charged after successful scan delivery
            </div>
          </div>
        )}

        {/* Repo URL input */}
        <div className="max-w-xl mx-auto mb-12">
          <label htmlFor="repo-url" className="block text-sm font-medium text-muted mb-2 text-center">
            1. Enter your GitHub or Gluecron repo URL
          </label>
          <input
            id="repo-url"
            type="url"
            value={repoUrl}
            onChange={(e) => { setRepoUrl(e.target.value); setError(null); }}
            placeholder="https://github.com/your-org/your-repo"
            className={`w-full px-4 py-3 rounded-xl border bg-white text-foreground placeholder:text-muted/50 focus:outline-none text-sm transition-colors ${
              error ? "border-danger focus:border-danger" : "border-border-strong focus:border-accent"
            }`}
          />
          {error && <p className="text-sm text-danger mt-2 text-center">{error}</p>}
          <p className="text-xs text-muted mt-2 text-center">2. Choose a tier below</p>
        </div>

        {/* Plan grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16 max-w-7xl mx-auto">
          {activePlans.map((plan) => (
            <div
              key={plan.id}
              className={`rounded-2xl p-6 transition-all flex flex-col ${
                plan.highlight ? "card-highlight" : "card"
              }`}
            >
              {"badge" in plan && plan.badge && (
                <div className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">
                  {plan.badge}
                </div>
              )}

              <h3 className="text-lg font-bold text-foreground mb-1">{plan.name}</h3>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-3xl font-bold gradient-text">{plan.price}</span>
                <span className="text-sm text-muted">{plan.period}</span>
              </div>
              <div className="text-xs text-accent font-medium mb-3">
                {plan.modules}
              </div>
              <p className="text-sm text-muted mb-5">{plan.description}</p>

              <button
                onClick={() => handleCheckout(plan.id)}
                disabled={loading === plan.id}
                className={`block w-full text-center py-3 px-5 rounded-xl font-semibold text-sm transition-all mb-6 cursor-pointer disabled:opacity-50 ${
                  plan.highlight ? "btn-primary" : "btn-secondary"
                }`}
              >
                {loading === plan.id ? "Redirecting..." : plan.cta}
              </button>

              <ul className="space-y-2.5 mt-auto">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <span className="text-success mt-0.5 shrink-0">&#10003;</span>
                    <span className="text-muted">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom trust line */}
        <p className="text-center text-xs text-muted mt-4">
          All scans include a detailed report and an AI fix PR.
          Continuous plans require the GateTest GitHub App.
          Payments processed securely via Stripe. Cancel subscriptions any time.
        </p>
      </div>
    </section>
  );
}
