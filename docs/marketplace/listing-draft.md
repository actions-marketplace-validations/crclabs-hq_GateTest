# GateTest — GitHub Marketplace listing draft

> Copy this file into the Marketplace listing form when Craig is ready to publish.
> Do not edit production tier descriptions without Craig's authorization (Bible Boss Rule #3 + #8).

---

## Tagline

> AI-powered CI that self-heals — 102 modules, one gate, zero fragmentation

(80 chars exactly — the Marketplace maximum.)

---

## Description (full Marketplace body)

GateTest replaces SonarQube, Snyk, ESLint, Cypress orchestration, Lighthouse, axe, broken-link-checker and seven other QA tools with a single composite GitHub Action.

One `uses:` line. 102 modules. One verdict.

### What it does

Every push and pull request runs through 91 inline checks:

- Security and supply chain: SSRF, SQL injection, hardcoded URLs, TLS misconfig, cookie hardening, dependency hygiene, CI-workflow security, secret rotation
- Reliability: N+1 queries, race conditions, resource leaks, retry hygiene, import cycles, error swallow, datetime bugs, money-as-float, async iteration footguns
- Web and UX: accessibility, performance, broken links, visual regressions, runtime errors via headless browser
- Infrastructure: Dockerfile hardening, Kubernetes manifests, Terraform/IaC, SQL migration safety, shell-script hygiene
- AI safety: prompt injection surfaces, client-bundled API keys, deprecated models, cost-DoS guards
- Code quality: dead code, TypeScript strictness, flaky tests, PR-size enforcement, ReDoS, cron-expression validation

The full list of modules and what each one catches lives at https://gatetest.ai.

### Why it is different

Existing autofixers patch single findings. GateTest runs a self-healing flywheel:

1. AST layer applies deterministic transforms first (zero cost, zero API calls).
2. Rule-based layer applies known-good fix recipes from the recipe store next.
3. Claude fills the remaining gap — Anthropic API spend is only spent on the long tail.
4. Every successful Claude-driven fix is distilled into a new recipe, so the deterministic layers grow over time.

The pricing tiers reflect depth, not module count: every paid tier scans the full 102 modules. The higher tiers add iterative fix loops, pair-review of every fix by a second Claude pass, architecture annotations, cross-finding correlation, per-finding Claude diagnosis, a board-ready CISO report, and a CTO-readable executive summary. Mutation testing and chaos / fuzz pass run via the GitHub Action (set `mutation: true` / `chaos: true`) because they need a CI runner — they ship wherever your CI runs.

### How to install

```yaml
- uses: crclabs-hq/gatetest@v1
  with:
    suite: quick
    auto-fix: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

That is the entire install. The action sets up Node, installs GateTest, runs the gate, and (when `auto-fix: true` and an Anthropic key is present) opens a fix PR.

### Pricing

- Free for public open-source repos via the open-source workflow.
- $29 per Quick Scan (4 critical modules).
- $99 per Full Scan (all 102 modules).
- $199 per Scan + Fix (full scan plus iterative fix loop, pair-review, architecture annotations).
- $399 per Nuclear (full scan plus per-finding Claude diagnosis, attack-chain correlation, board-ready CISO report, executive summary; mutation testing and chaos / fuzz pass also available via the GitHub Action — `mutation: true` / `chaos: true`).
- $49/month Continuous for unlimited push-triggered scans.

Pricing is unified at https://gatetest.ai/pricing.

### Trust signals

- 102 modules. Single binary. Zero external dependencies on the customer side.
- 3500+ unit tests pass on every commit.
- Used in production by Crontech and Gluecron (Craig-owned platforms protected via the same engine).
- Pay-on-completion: customers are only charged once a scan delivers.

---

## Features list

- 91 unified quality modules — security, reliability, infra, AI safety, accessibility, performance — one composite action runs them all.
- Self-healing CI — AST + rule + Claude flywheel auto-opens fix PRs for every blocking finding when an Anthropic key is configured.
- Honest pricing — pay per scan, not per seat. Free for OSS.
- Five output formats — console, JSON, SARIF (for GitHub Code Scanning), JUnit, HTML.
- Compatible with any monorepo layout — point at any working directory.
- Iterative fix loop on $199+ tiers — every fix is re-scanned in isolation and retried with the failure context up to three times.
- Pair-review and architecture annotations on $199+ tiers — second Claude pass critiques each fix on a four-axis rubric.

---

## Screenshots needed (Craig to add)

The Marketplace listing requires at least one and recommends five screenshots. Capture these from the live product before submitting:

- A passing run on a clean repo — green check, error count = 0.
- A blocking run with three findings expanded — shows the per-module breakdown.
- A pull request that GateTest auto-opened with a Claude-generated fix.
- The pair-review comment on a $199-tier PR (four-axis rubric visible).
- The executive-summary section from a $399-tier Nuclear run.

---

## Pricing model (for the GitHub form)

Free for public repos. Paid for private repos with billing handled at https://gatetest.ai/pricing — link out, not Marketplace-billed at launch.

(When Marketplace billing is enabled in a later release, the price IDs already exist in Stripe. Boss Rule item: Craig must authorize the cut-over.)

---

## Support

Live chat at https://gatetest.ai. No email support intake (per Craig's directive).

---

## Required permissions explained

- `contents: read` — to scan source code on the runner. The action never modifies your repo unless `auto-fix: true` opens a PR.
- `pull-requests: write` — to open an auto-fix PR when the gate blocks and `auto-fix: true` is on.
- `checks: write` — to publish the gate verdict as a GitHub commit status check.
- `issues: write` — to open advisory issues for findings that need a human decision (off by default, opt-in via tier).
- `security-events: write` — to upload SARIF results to GitHub Code Scanning when `report-format: sarif`.

The action requests no other scopes. The Anthropic API key, if supplied, is read only from the workflow `env:` block and is never sent anywhere except api.anthropic.com.

---

## Privacy

https://gatetest.ai/legal/privacy

Source code scanned by the gate never leaves the runner. The AI fix path sends only the specific failing snippet (plus surrounding context) to api.anthropic.com — see the privacy policy for the full data flow.

---

## Categories (suggested)

- Code quality
- Continuous integration
- Security
