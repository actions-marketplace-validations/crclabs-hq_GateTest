# GateTest

**AI writes fast. GateTest keeps it honest.**

The most advanced QA gate for AI-generated code. **90 test modules** scan your entire codebase — security, accessibility, performance, AI code review, and everything in between. We don't just find bugs. We fix them.

[![Scanned by GateTest](https://gatetest.ai/api/badge?status=passing)](https://gatetest.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Modules](https://img.shields.io/badge/modules-90-brightgreen)]()
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)]()
[![npm](https://img.shields.io/npm/v/gatetest.svg)](https://www.npmjs.com/package/gatetest)

---

## Why GateTest?

Every team using AI coding assistants (Copilot, Claude, Cursor) is duct-taping 8-10 testing tools together. Different configs. Different dashboards. Different billing.

**GateTest replaces them all with one scan, one report, one gate decision: PASS or BLOCKED.**

> **We dogfood this.** GateTest scans itself on every push. Check the [CI workflow](.github/workflows/ci.yml).

| They use | GateTest replaces it with |
|----------|--------------------------|
| Jest/Vitest/Mocha | `gatetest --module unitTests` |
| Playwright/Cypress | `gatetest --module e2e` |
| ESLint/Stylelint | `gatetest --module lint` |
| Snyk/npm audit | `gatetest --module security` |
| Lighthouse | `gatetest --module performance` |
| axe/pa11y | `gatetest --module accessibility` |
| Percy/Chromatic | `gatetest --module visual` |
| SonarQube | `gatetest --module codeQuality` |
| git-secrets | `gatetest --module secrets` |
| broken-link-checker | `gatetest --module links` |

Plus 12 more modules they don't have: AI code review, **fake-fix detector**, mutation testing, chaos testing, autonomous exploration, live crawling, data integrity, documentation validation, compatibility analysis, integration test detection, CI generation, and SARIF output.

---

## Install (anywhere)

GateTest is published to multiple channels. Pick what fits your workflow.

### npm (recommended for local + CI)

```bash
npm install -g gatetest
# or one-shot, no install:
npx gatetest --suite quick
```

### Drop-in CI gate (zero install on your side)

From the root of any git repo, this writes the GitHub Actions workflow + Husky pre-push hook + protection marker:

```bash
curl -sSL https://raw.githubusercontent.com/ccantynz-alt/gatetest/main/integrations/scripts/install.sh | bash
git add .github .husky .gatetest.json
git commit -m "chore: install GateTest quality gate"
git push
```

The CI workflow clones GateTest at runtime — nothing to install on your side.

### MCP server (Claude Code / Cursor / Cline / Aider)

```jsonc
// In your MCP client config
{
  "mcpServers": {
    "gatetest": {
      "command": "npx",
      "args": ["-y", "gatetest", "mcp"]
    }
  }
}
```

Or directly: `npx gatetest-mcp` exposes scan + fix tools to any MCP-aware AI builder.

### Hosted (no install at all)

Visit [gatetest.ai](https://gatetest.ai) and paste a repo URL. Pay-on-completion: card hold released if scan fails.

---

## Quick Start

```bash
# Initialize in your project
gatetest --init

# Run quick checks (syntax, lint, secrets, code quality)
gatetest --suite quick

# Run all 90 modules
gatetest --suite full

# Run with auto-fix (fixes safe issues automatically)
gatetest --suite full --fix

# Only scan changed files (instant pre-commit)
gatetest --diff

# Incremental PR scan — only files changed since the base ref (5x-30x faster)
gatetest --since main
gatetest --pr                 # alias for --since origin/main

# Watch mode — re-scan on every file change
gatetest --watch

# Run a specific module
gatetest --module security
gatetest --module accessibility
gatetest --module aiReview
```

---

## All 22 Modules

| Module | What It Does |
|--------|-------------|
| **syntax** | JS/TS/JSON/YAML/CSS/HTML validation, import resolution, dangling patterns |
| **lint** | ESLint, Stylelint, Markdownlint integration |
| **secrets** | 14 patterns: AWS keys, GitHub tokens, Stripe keys, JWTs, private keys, DB connection strings |
| **codeQuality** | console.log, debugger, TODO/FIXME, eval, function length, file length, complexity |
| **unitTests** | Auto-detects Jest/Vitest/Mocha/pytest, runs tests, checks coverage |
| **integrationTests** | Detects API endpoints, DB operations, verifies test coverage |
| **e2e** | Playwright/Cypress/Puppeteer execution |
| **visual** | Visual regression, layout shifts, font loading, design tokens |
| **accessibility** | WCAG 2.2 AAA — 542 lines of checks: alt text, ARIA, focus, contrast, heading hierarchy |
| **performance** | Bundle budgets, Core Web Vitals, image optimization, memory leak detection |
| **security** | OWASP patterns, CVE scanning, Docker security, license compliance, .gitignore validation |
| **seo** | Meta tags, Open Graph, structured data, canonical URLs, sitemaps |
| **links** | Broken internal + external link detection |
| **compatibility** | Browser matrix, CSS/JS API compat, vendor prefix checks, polyfill detection |
| **dataIntegrity** | Migration safety, SQL injection, PII handling, idempotency checks |
| **documentation** | README, CHANGELOG, JSDoc coverage, license, contributing guide, dead links |
| **liveCrawler** | Playwright-powered full-site crawl and verification |
| **explorer** | Autonomous interactive element testing — clicks buttons, fills forms, verifies state |
| **chaos** | Chaos & resilience testing — slow networks, API failures, missing resources |
| **mutation** | Mutation testing — modifies source code to verify tests actually catch bugs |
| **aiReview** | AI-powered code review using Claude — finds real bugs, suggests fixes with corrected code |
| **fakeFixDetector** | Catches symptom patching, disabled tests, stub functions — dual engine (pattern + AI) |

---

## Features

- **90 test modules** — More coverage than any single competitor
- **5 report formats** — Console, JSON, HTML, SARIF (GitHub Security), JUnit XML (CI)
- **Severity levels** — error (blocks gate), warning (reports), info (informational)
- **Auto-fix engine** — Modules can automatically repair safe issues
- **Diff-based scanning** — `--diff` only checks git-changed files (instant pre-commit)
- **Watch mode** — `--watch` monitors file changes, re-scans continuously
- **Mutation testing** — Tests the tests themselves
- **AI code review** — Claude analyzes your code for real bugs, not just patterns
- **CI/CD generation** — `--ci-init github|gitlab|circleci` bootstraps pipelines
- **File caching** — SHA-256 hashing skips unchanged files
- **Zero dependencies** — Pure Node.js. Install and run anywhere.
- **Resilient GitHub access** — Retry with backoff, circuit breaker, multi-strategy repo access

---

## CLI Reference

```
gatetest                          Run standard checks
gatetest --suite full             Run every module (90 modules)
gatetest --suite quick            Fast pre-commit checks
gatetest --module security        Run a single module
gatetest --diff                   Only scan git-changed files
gatetest --since <ref>            Incremental scan: only files changed vs <ref>
gatetest --pr                     Alias for --since origin/main (PR workflow)
gatetest --fix                    Auto-fix safe issues
gatetest --watch                  Watch mode — re-scan on changes
gatetest --sarif                  Output SARIF for GitHub Security tab
gatetest --junit                  Output JUnit XML for CI pipelines
gatetest --ci-init github         Generate GitHub Actions workflow
gatetest --ci-init gitlab         Generate GitLab CI config
gatetest --ci-init circleci       Generate CircleCI config
gatetest --crawl <url>            Crawl a live website
gatetest --parallel               Run modules in parallel
gatetest --stop-first             Stop on first failure
gatetest --health                 Check GitHub API connectivity
gatetest --list                   List all available modules
gatetest --validate               Validate CLAUDE.md file
```

---

## GitHub App

Install GateTest as a GitHub App to automatically scan every push and PR:

1. Visit [gatetest.ai/github/setup](https://gatetest.ai/github/setup)
2. Click "Install GateTest on GitHub"
3. Select your repos
4. Every push and PR gets scanned automatically

Results appear as commit status checks and detailed PR comments.

---

## Paid Scans

Don't want to run it yourself? We'll scan your repo and deliver a full report.

| Tier | Price | What You Get |
|------|-------|-------------|
| **Quick Scan** | $29 | 4 modules, instant report |
| **Full Scan** | $99 | All 90 modules, SARIF + JUnit |
| **Scan + Fix** | $199 | Full scan + auto-fix PR + pair-review + architecture annotations |
| **Nuclear** | $399 | Everything + Claude per-finding diagnosis + cross-finding correlation + mutation + chaos + executive summary |

**Pay only when the scan completes.** Card hold released if scan fails. Zero risk.

Visit [gatetest.ai](https://gatetest.ai) to get started.

---

## Gate Rules

1. **Zero Tolerance** — Any error-severity check failure blocks the pipeline
2. **No Manual Overrides** — Checks pass or the build is rejected
3. **No Partial Deploys** — Everything passes or nothing ships
4. **Evidence Required** — Every gate pass produces a timestamped report
5. **Test the Tests** — Mutation testing validates tests actually catch bugs

---

## License

MIT
