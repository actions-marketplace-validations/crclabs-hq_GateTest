# GateTest Marketing & Positioning

This document captures the core messaging, competitive positioning, and sales
strategy for GateTest. This is the source of truth for all marketing materials,
the gatetest.ai website, and investor communications.

---

## Tagline

**"AI writes fast. GateTest keeps it honest."**

## One-liner

GateTest is the advanced QA gate between AI and GitHub. Nothing ships unless it's pristine.

## Elevator pitch

Every company building with AI is duct-taping 8-10 separate testing tools together —
Playwright for E2E, Jest for unit tests, Snyk for security, Lighthouse for performance,
axe for accessibility, Percy for visual regression, ESLint for linting, git-secrets for
credentials. Different configs, different dashboards, different billing.

GateTest replaces that entire stack with one system, one config file, one report, and
one gate decision: PASS or BLOCKED.

It's the first QA system built specifically for AI-generated code — catching the exact
patterns AI gets wrong before they touch production.

---

## Competitive Positioning

### The market today (fragmented, single-purpose tools)

| Tool | What it does | Categories covered |
|------|-------------|-------------------|
| Playwright | Browser E2E testing only | ~1 |
| Cypress | Browser E2E testing only | ~1 |
| Jest | Unit tests only | ~1 |
| ESLint | Linting only | ~1 |
| Lighthouse | Performance + SEO + A11y | ~4 |
| Snyk | Security/dependency scanning | ~1 |
| Percy | Visual regression only | ~1 |
| axe | Accessibility only | ~1 |
| SonarQube | Code quality + some security | ~3 |

### GateTest (unified, 16 modules, one gate)

| Module | Coverage |
|--------|----------|
| syntax | JS/TS/JSON compilation, zero errors |
| lint | ESLint, Stylelint, Markdownlint |
| secrets | API keys, tokens, passwords, private keys |
| codeQuality | console.log, debugger, TODO, eval, complexity |
| unitTests | Auto-detects Jest/Vitest/Mocha, coverage thresholds |
| integrationTests | API & service integration tests |
| e2e | Playwright/Cypress/Puppeteer integration |
| visual | Layout shifts, fonts, z-index, design tokens, viewports |
| accessibility | WCAG 2.2 automated audit (AA + AAA-aligned) — alt text, ARIA, focus, contrast |
| performance | Bundle budgets, Core Web Vitals, Lighthouse scores |
| security | OWASP patterns, dependency CVEs, CSP, XSS/SQLi |
| seo | Meta tags, Open Graph, sitemaps, structured data |
| links | Broken internal + external link detection |
| compatibility | Browser matrix validation, modern API polyfill checks |
| dataIntegrity | Database schema, migrations, PII handling |
| documentation | README, CHANGELOG, env docs completeness |

### Key differentiators

1. **16x the surface area** — No single competitor covers more than 4 categories.
   GateTest covers 16. One tool replaces the entire testing toolchain.

2. **AI-native QA** — The first quality gate built for the AI coding era. Catches
   the specific patterns AI gets wrong:
   - Hallucinated imports
   - console.log/debugger statements left behind
   - Hardcoded API keys in generated code
   - Missing error handling
   - Incomplete accessibility
   - Memory leaks (forgotten cleanup, dangling event listeners)
   - Broken internal links from AI refactoring

3. **Zero-tolerance enforcement** — Not warnings. Not suggestions. Pipeline blocking.
   One failure in any of the 16 modules = entire build blocked. No overrides.

4. **One system, one report, one decision** — No more juggling 10 dashboards.
   PASS or BLOCKED. That's it.

5. **Continuous scanning** — GateTest doesn't sleep. Background scanners monitor
   dependencies, CVEs, uptime, performance baselines, and security headers 24/7.

6. **CLAUDE.md as single source of truth** — All quality thresholds, checklists,
   and gate rules live in one human-readable file that's enforced automatically.

7. **Designed to consolidate a dozen single-purpose QA tools into one gate.** — One install, one report, one bill across security, quality, dependencies, accessibility, performance, AI safety, and infrastructure hardening.

---

## Target audience

### Primary: AI-assisted development teams
- Teams using Claude, Copilot, Cursor, or any AI coding assistant
- AI generates code fast but introduces quality gaps
- GateTest is the safety net between AI output and production

### Secondary: Quality-conscious engineering teams
- Teams tired of managing 8-10 separate testing tools
- Teams that need compliance evidence (SOC2, HIPAA, PCI-DSS)
- Teams shipping to regulated industries

### Tertiary: Solo developers and indie hackers
- Ship confidently without a QA team
- Free CLI tier = zero cost to get started

---

## Revenue model

### THE MODEL: Pay on completion. Zero customer risk.

We don't charge until the job is done. We hold the card, run the scan,
deliver the report. If we can't complete it, the hold is released.
No other QA tool on earth offers this. It's our killer advantage.

**Payment flow (Stripe Payment Intents, manual capture):**
1. Customer selects scan tier → card hold placed
2. GateTest clones repo, runs scan, generates report
3. Scan completes → hold captured → customer charged
4. Scan fails (503, access denied, outage) → hold released → customer pays nothing

### Pricing tiers — per scan

| Tier | Modules | What They Get | Price |
|------|---------|---------------|-------|
| **Quick Scan** | 4 (syntax, lint, secrets, code quality) | Report + pass/fail | **$29** |
| **Full Scan** | All 102 modules | Full report, SARIF, JUnit | **$99** |
| **Scan + Fix** | All 102 modules + auto-fix | Report + PR with fixes applied | **$199** |
| **Nuclear** | 102 modules + per-finding Claude diagnosis + correlation + CISO report + exec summary + auto-fix PR | Everything on the website-only scan. Mutation testing + chaos / fuzz pass also available via the GitHub Action where a CI runner is present. | **$399** |

### Recurring tier — after first scan proves value

| Tier | What They Get | Price |
|------|---------------|-------|
| **Continuous** | Scan every push, dashboard, alerts | **$49/month** |
| **Enterprise** | Continuous + compliance + SSO + SLA | **Custom** |

### Why this model wins

1. **Zero risk to buyer** — "We don't charge if we can't scan." Nobody else says this.
2. **Low entry barrier** — $29 one-time is easier than $49/month commitment.
3. **Value proven before recurring** — After 2 paid scans, $49/month is obvious.
4. **The $199 tier is the money maker** — Every other tool just REPORTS problems.
   GateTest REPORTS and FIXES. That's worth $199 every time.
5. **Nuclear at $399** — For launches, audits, compliance checks. High margin, low volume.

### Revenue math

- 10 Quick Scans/day = $290/day = $8,700/month
- 5 Full Scans/day = $495/day = $14,850/month
- 3 Scan+Fix/day = $597/day = $17,910/month
- 20 Continuous subscribers = $980/month recurring

**Conservative month 1 target: $5,000-10,000**
**Month 3 target: $20,000+ (mix of scans + recurring)**

### Key principle
**Never charge before delivering.** The hold-then-charge model means
customers trust us from scan #1. Trust converts to recurring revenue.

---

## Why people pay when free alternatives exist

People don't pay for code. They pay for:

1. **"Scan my repo and fix it"** — That's a service, not a tool.
   The CLI is free. Having us run it, generate fixes, and deliver
   a PR? That's worth $199. Every. Single. Time.

2. **Not running it themselves** — Self-hosting costs engineering time.
   A startup with 5 devs would rather pay $99 than spend 2 days
   on infrastructure. That dev time costs them $2,000+.

3. **The report** — Timestamped evidence that their code passed 20
   quality modules. Hand that to an investor, a client, or an auditor.

4. **The auto-fix** — GateTest doesn't just find problems. It FIXES them.
   A PR with 15 auto-fixed issues landing in your repo? That's magic.

5. **Continuous scanning** — Someone has to run the 24/7 scanner. Most
   teams don't want to manage that. "We'll run it for you" = money.

### Proof this model works
- GitHub charges $21/user/month — Git is free
- Slack makes billions — IRC/Discord are free
- Datadog is worth $30B — Grafana is free
- Vercel charges — self-hosting Next.js is free
- Snyk charges — npm audit is free

---

## Website copy (gatetest.ai)

### Hero section
**Headline**: "AI writes fast. GateTest keeps it honest."
**Subhead**: 20 test modules scan your entire codebase. We find the bugs AND fix them.
You only pay when the scan completes.
**CTA**: "Scan My Repo — $29" / "See All Plans"

### How it works section
1. **Point us at your repo** — GitHub URL, that's it
2. **We scan everything** — 102 modules, 800+ checks, security to accessibility
3. **Get your report** — PASS or BLOCKED, with every issue detailed
4. **We fix it** — Auto-fix PR lands in your repo (Scan+Fix tier)
5. **Pay only if we deliver** — Card hold released if scan can't complete

### The problem section
"Your team uses 8-10 separate tools for testing. Different configs. Different
dashboards. Different billing. Things slip through the cracks. GateTest
replaces them all with one scan, one report, one gate."

### Built for AI section
"AI coding assistants write code 10x faster — but they also introduce
hallucinated imports, forgotten cleanup, hardcoded secrets, and incomplete
accessibility. GateTest catches every one of these AND fixes them automatically."

### Comparison section
(Use the competitive positioning table from above)

### Pricing section
- **Quick Scan** ($29): 4 modules, instant report
- **Full Scan** ($99): All 102 modules, full report
- **Scan + Fix** ($199): Full scan + auto-fix PR — MOST POPULAR
- **Nuclear** ($399): Everything plus per-finding Claude diagnosis, cross-finding correlation, board-ready CISO report, executive summary. Mutation testing and chaos / fuzz pass also available via the GitHub Action (`mutation: true` / `chaos: true`) — runs wherever your CI runs.
- **Continuous** ($49/mo): Scan every push, dashboard, alerts
- All tiers: pay on completion only. Card hold released if scan fails.

---

## Brand voice

- Confident but not arrogant
- Technical but accessible
- Zero-bullshit — say what it does, not what it "empowers" or "leverages"
- Short sentences. Direct. Like this.

---

## Domain

**gatetest.ai** — secured.

---

## Version

Marketing doc v2.0.0 — Pay-on-completion model
Last updated: 2026-04-08
