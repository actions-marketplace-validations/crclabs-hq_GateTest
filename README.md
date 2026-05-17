# GateTest

### One gate. 91 modules. Self-healing CI.

**AI-powered code quality. Pay only if we fix it.**

<!-- npm-version badge — re-enable after first `npm publish`:
[![npm](https://img.shields.io/npm/v/gatetest.svg)](https://www.npmjs.com/package/gatetest)
-->
[![CI](https://github.com/ccantynz-alt/gatetest/actions/workflows/ci.yml/badge.svg)](https://github.com/ccantynz-alt/gatetest/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Modules](https://img.shields.io/badge/modules-91-purple.svg)](#what-it-replaces)
[![Tests](https://img.shields.io/badge/tests-3500%2B-brightgreen.svg)](#real-repo-proofs)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org/)
<!-- Marketplace listing — re-enable when the GitHub Marketplace approval lands:
[![GitHub Marketplace](https://img.shields.io/badge/marketplace-GateTest-2ea44f.svg)](https://github.com/marketplace/gatetest)
-->

---

## The 30-second pitch

**GateTest is a single CLI plus a composite GitHub Action that runs 91 static-analysis modules against any codebase, then uses Claude to repair the findings it can.** It replaces SonarQube, Snyk, ESLint, Cypress, Lighthouse, axe, pa11y, and twenty-plus other tools with one config, one gate decision, and one report.

**It is different because the cost trends to zero.** Deterministic AST and rule-based layers run first — these are free and ship the fix in milliseconds. Claude only runs on patterns nothing else has seen. Every Claude win is distilled into a reusable recipe, so the next time the same pattern appears anywhere in the network it is handled for free. The longer you run GateTest, the less of it is paid work.

**What you get depends on the tier.** A pull request with the fixes, regression tests pinned to each fix, an architecture-shape critique, a cross-finding attack-chain analysis, and a CTO-readable executive summary — in whichever combination the tier you bought includes. The card is held when you check out and only captured if the scan delivers; if it fails, the hold is released.

---

## Install in 30 seconds

### GitHub Action — recommended for most users

Drop this in `.github/workflows/gatetest.yml`:

```yaml
name: GateTest Quality Gate
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ccantynz-alt/gatetest@v1
        with:
          suite: full
          auto-fix: ${{ github.event_name == 'pull_request' }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action is a composite — no Docker pull, no container build. It installs GateTest, runs the gate, and if `auto-fix: true` and `ANTHROPIC_API_KEY` is set, runs the AI repair loop on a blocking gate. See [`action.yml`](action.yml) for every input.

### CLI — local development

```bash
# Run against the current directory, no install:
npx github:ccantynz-alt/gatetest --suite quick

# Or clone and run from source:
git clone https://github.com/ccantynz-alt/gatetest
cd gatetest && npm install
node bin/gatetest.js --suite quick
```

> The package is not yet on npm. `npm install -g gatetest` will work after the first publish — track [issue tracker](https://github.com/ccantynz-alt/gatetest/issues) for the release tag.

### Website — no install at all

Visit [gatetest.ai/web](https://gatetest.ai/web) and paste any URL. You get a free preview and a paid full report. For WordPress sites use [gatetest.ai/wp](https://gatetest.ai/wp).

### Replay a failing CI run locally

Reproduce any failing GitHub Actions run on your laptop in seconds:

```bash
gatetest replay https://github.com/owner/repo/actions/runs/12345
```

This fetches the run, identifies which steps failed, and runs them locally
against your current working tree. Output tells you whether the failure
reproduces, doesn't reproduce (flaky CI), or hits a different error.

Authentication is optional — if you have a `GITHUB_TOKEN` set or `gh` CLI
installed, replay can read private repo runs. Otherwise it uses the
unauthenticated rate limit (60 req/hour, fine for a few replays).

---

## The flywheel — why GateTest gets cheaper over time

```
                ┌──────────────────────────┐
   CI BREAKS    │  Failed workflow run     │
       ──>      └────────────┬─────────────┘
                             │
                ┌────────────▼─────────────┐
                │  AI CI-fixer reads logs  │
                │  + failing files         │
                └────────────┬─────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │  AST   │ →  │  Rule  │ →  │ Recipe │   ─── ALL FREE ───
         └────┬───┘    └────┬───┘    └────┬───┘
              │             │             │   (none matched?)
              └─────────────┴─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ Claude — paid, one shot  │
                │ Result distilled into a  │
                │ recipe for next time     │
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │  PR opens with the fix   │
                │  + regression test       │
                └──────────────────────────┘
```

**First time we see a pattern: Claude. Every time after: free.** The longer you run GateTest, the cheaper it gets.

---

## What it replaces

One config, one bill, one gate decision. Twelve-plus tools dissolve into single CLI flags.

| Their tool                                 | GateTest module                                    |
| ------------------------------------------ | -------------------------------------------------- |
| Snyk Code, Dependabot, npm audit           | `security`, `dependencies`                         |
| SonarQube                                  | `codeQuality` + every other module                 |
| ESLint, Stylelint                          | `lint`                                             |
| Cypress, BrowserStack, Sauce Labs          | `e2e`                                              |
| Lighthouse                                 | `performance`                                      |
| axe, pa11y                                 | `accessibility`                                    |
| Percy, Chromatic                           | `visual`                                           |
| git-secrets, TruffleHog                    | `secrets`, `secretRotation`                        |
| hadolint, dockle                           | `dockerfile`                                       |
| actionlint, zizmor, StepSecurity           | `ciSecurity`                                       |
| tfsec, Checkov, Terrascan                  | `terraform`                                        |
| kube-score, kubeaudit, Polaris             | `kubernetes`                                       |
| Stryker, Pitest                            | `mutation`                                         |
| broken-link-checker                        | `links`                                            |
| _(none — fragmented across ESLint rules)_  | `errorSwallow`, `nPlusOne`, `flakyTests`           |
| _(none — no static tool exists)_           | `redos`, `moneyFloat`, `logPii`, `tlsSecurity`     |
| _(none — runtime profilers only)_          | `resourceLeak`, `raceCondition`, `retryHygiene`    |

**Twelve-plus tools. One config. One bill.** Full module catalogue: run `node bin/gatetest.js --list` or read it on [gatetest.ai](https://gatetest.ai).

---

## Tiers and pricing

Pay-on-completion. The card is held at checkout and only captured if the scan delivers a report; if it fails, the hold is released.

| Tier              | Price   | What you get                                                                                                                                       |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quick Scan**    | $29     | 4 modules — syntax, linting, secrets, code quality. Fastest path to a first signal.                                                                |
| **Full Scan**     | $99     | All 91 modules. Auto-fix PR included. SARIF + JUnit reports.                                                                                       |
| **Scan + Fix**    | $199    | Everything in Full, plus a second-Claude pair-review critique on every fix and an architecture-shape design-observations report.                   |
| **Nuclear**       | $399    | Everything in Scan + Fix, plus real Claude diagnosis on every finding, cross-finding attack-chain correlation, mutation testing, chaos / fuzz pass, and a CTO-readable executive summary. |

Live prices and Stripe checkout at [gatetest.ai](https://gatetest.ai).

---

## Honest limits

GateTest is not magic. The things it does not yet do, said out loud:

- **The npm package is not yet published.** Install today is via the GitHub Action (composite, recommended), `npx github:ccantynz-alt/gatetest`, or a `git clone`. The first `npm publish` is queued, not shipped.
- **Headless-browser modules (`liveCrawler`, `runtimeErrors`, `explorer`, `chaos`) degrade gracefully on Vercel serverless.** Chromium cannot launch inside the function. The modules emit an info-level skip and the rest of the scan continues — full power requires the CLI, a worker, or local dev.
- **The GitHub Marketplace listing is drafted, not approved.** Approval is in progress (the action itself works regardless — `ccantynz-alt/gatetest@v1` resolves today).
- **`installation_id` is not persisted across GitHub App installs.** Multi-org customers cannot yet be correlated to a single billing account; this is tracked as Known Issue #22 in [CLAUDE.md](CLAUDE.md).
- **PR comments are not idempotent.** A busy PR with many pushes will collect duplicate scan comments. Tracked as Known Issue #23.

The full Known Issues table (with severity and status) lives in [CLAUDE.md](CLAUDE.md) — that file is the project's source of truth.

---

## Architecture

**Static engine.** Ninety-one modules, every one extending `BaseModule`. Each module is a self-contained scanner that emits checks at three severity levels (error blocks the gate, warning reports, info is informational). The runner is `EventEmitter`-based, supports parallel execution, diff-mode (`--diff` scans only git-changed files), watch mode, and five output formats (Console, JSON, HTML, SARIF for the GitHub Security tab, JUnit XML for any CI). The gate has zero runtime dependencies aside from one MCP SDK pin — `node bin/gatetest.js --list` runs anywhere Node 20+ runs.

**Website and payments.** [gatetest.ai](https://gatetest.ai) is Next.js 16 with the App Router, Tailwind 4, and Stripe in hold-then-charge mode via Payment Intents with manual capture. All scan state is persisted in Stripe metadata so the serverless functions stay stateless across requests — there is no shared in-memory state and no webhook is required for the critical user flow. The scan executes inside the function response and reports back directly.

**AI layer.** Claude (Anthropic). On the GitHub Action the customer brings their own `ANTHROPIC_API_KEY` and pays Anthropic directly. On the website the key is managed and the cost is folded into the tier price. Every Claude success is distilled into a recipe by the flywheel orchestrator (see [`lib/`](lib/) and the AI CI-fixer at [`scripts/ai-ci-fixer.js`](scripts/ai-ci-fixer.js)) so subsequent runs on the same pattern are deterministic and free.

The codebase ships under MIT, the gate runs locally with no external calls, and every architectural decision is documented inline in [CLAUDE.md](CLAUDE.md).

---

## Real-repo proofs

GateTest is dogfooded against itself on every push, and the team runs the full Nuclear pipeline against external production codebases before shipping changes that touch the deeper tiers. The reports below are reproducible artifacts in this repo:

- **AI CI-fixer end-to-end run** — full orchestrator path exercised (log → parse → Claude → patch → gate → commit → push → PR): [docs/proofs/ai-ci-fixer-real-run.md](docs/proofs/ai-ci-fixer-real-run.md)
- **GateTest scanning itself** — quick-suite self-scan, 30 of 39 modules pass, 37 errors found and triaged: [docs/proofs/phase-1-self-scan.md](docs/proofs/phase-1-self-scan.md)
- **Iterative fix loop on the live repo** — one-attempt fix on `src/runtime/alerts.js`, 8.5 seconds wall time, syntax gate green: [docs/proofs/phase-1-self-fix-real.md](docs/proofs/phase-1-self-fix-real.md)
- **Nuclear scan of Crontech.ai** — Bun + Turbo TypeScript monorepo, 754 errors found, 23 of 39 modules pass, two critical attack chains including a supply-chain CI takeover: [docs/proofs/phase-2-3-crontech-real-customer-grade.md](docs/proofs/phase-2-3-crontech-real-customer-grade.md)
- **Nuclear scan of Gluecron.com and MarcoReid.com** — 649 errors and three chains on Gluecron (incl. an "operational lock-in" chain neither finding describes alone); 124 errors on MarcoReid with a textbook `parseFloat`-on-money bug in trust-account handling, correlator honestly returned 0 chains: [docs/proofs/phase-2-3-gluecron-marcoreid.md](docs/proofs/phase-2-3-gluecron-marcoreid.md)
- **Pair-review and architecture annotator on the self-scan** — Phase 2 deliverables exercised end-to-end: [docs/proofs/phase-2-self-pair-review-and-architecture.md](docs/proofs/phase-2-self-pair-review-and-architecture.md)
- **Full Nuclear pipeline on the self-scan** — 12 of 12 findings diagnosed, four chains including a session-forgery vector: [docs/proofs/phase-3-self-nuclear.md](docs/proofs/phase-3-self-nuclear.md)

Total Anthropic spend across the four external real-repo Nuclear proofs: roughly three to four US dollars. At the $399 Nuclear tier that is a hundred-times-plus margin, before recipe distillation reduces it further on repeat scans.

---

## Develop and contribute

```bash
git clone https://github.com/ccantynz-alt/gatetest
cd gatetest
npm install
(cd website && npm install)
node --test tests/*.test.js
node bin/gatetest.js --list
```

The Bible — [CLAUDE.md](CLAUDE.md) — is required reading for contributors. It defines the architecture, the quality bar, the forbidden list, the protected platforms, and the authorization rules that apply to anything touching money, user data, or public-facing communication.

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/ccantynz-alt/gatetest/issues). Small PRs that fix one thing and add a test are merged fastest. The pre-commit and pre-push hooks under [`src/hooks/`](src/hooks/) run the gate locally — running them before pushing keeps CI green.

---

## License

MIT — see [LICENSE](LICENSE).

---

<sub>
GateTest is built and maintained at <a href="https://gatetest.ai">gatetest.ai</a>.
Talk to the team via the chat on the site. File bugs at <a href="https://github.com/ccantynz-alt/gatetest/issues">GitHub Issues</a>.
</sub>
