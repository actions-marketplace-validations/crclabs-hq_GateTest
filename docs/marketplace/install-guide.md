# GateTest — install guide

Drop the GateTest action into any GitHub workflow with one `uses:` line.

---

## Quickstart

Create `.github/workflows/gatetest.yml`:

```yaml
name: GateTest
on:
  push:
    branches: [main]
  pull_request:

jobs:
  gate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
    steps:
      - uses: actions/checkout@v4
      - uses: ccantynz-alt/gatetest@v1
```

That is the entire install. Push the file, open a PR, the gate runs.

---

## With AI auto-repair

When the gate finds something it can fix, let Claude propose the patch:

```yaml
- uses: ccantynz-alt/gatetest@v1
  with:
    suite: quick
    auto-fix: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

When the gate blocks and an Anthropic key is present, the action opens a follow-up PR with the proposed fix. The original failing PR is never modified — auto-repair runs as an additive workflow.

---

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `suite` | `quick` | Which suite to run: `quick` (4 modules), `full` (91), `scan_fix`, `nuclear`. |
| `auto-fix` | `false` | When `true` AND the gate blocks AND `ANTHROPIC_API_KEY` is set, run the AI CI-fixer. |
| `node-version` | `22` | Node.js version to set up on the runner. GateTest requires Node 20+. |
| `working-directory` | `.` | Repository sub-directory to scan. Useful for monorepos. |
| `report-format` | `console` | Output format: `console`, `json`, `sarif`, or `junit`. |
| `fail-on-warning` | `false` | When `true`, warning-severity findings also block the gate. |

### Example: SARIF upload for GitHub Code Scanning

```yaml
- uses: ccantynz-alt/gatetest@v1
  id: gatetest
  with:
    suite: full
    report-format: sarif

- name: Upload SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ${{ steps.gatetest.outputs.report-path }}
```

### Example: monorepo

```yaml
- uses: ccantynz-alt/gatetest@v1
  with:
    working-directory: ./apps/api
```

---

## Outputs

| Output | Description |
| --- | --- |
| `gate-status` | `passed` or `blocked`. |
| `error-count` | Number of error-severity findings. |
| `warning-count` | Number of warning-severity findings. |
| `report-path` | Filesystem path to the report file (empty when `report-format` is `console`). |

Read outputs in later steps with `${{ steps.<id>.outputs.<name> }}`.

---

## Environment variables

| Variable | Required when | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `auto-fix: true` | Claude API key used by the AI CI-fixer. |
| `GITHUB_TOKEN` | Auto-fix opens a PR | The default `${{ secrets.GITHUB_TOKEN }}` is enough. |
| `GATETEST_RECIPE_STORE_URL` | Optional | Custom recipe-store endpoint for the flywheel layer. |
| `MAX_FIX_ATTEMPTS` | Optional | Cap on auto-fix retries (default 3). |
| `CLAUDE_MODEL` | Optional | Override the Claude model used by the fixer. |

Set them in the `env:` block on the step or job — never commit secrets to the repo (Bible Forbidden #6).

---

## Suite comparison

| Suite | Modules | What runs | Typical use |
| --- | --- | --- | --- |
| `quick` | 4 critical modules | Secrets, syntax, dependencies, lint | PR gate on every push |
| `full` | All 91 modules | Everything the gate ships with | Pre-merge to main, nightly scan |
| `scan_fix` | 91 + fix loop | Full scan plus iterative Claude fix loop, pair-review, architecture annotator | Customers on the $199 tier |
| `nuclear` | 91 + correlation + adversarial | Full scan plus per-finding Claude diagnosis, cross-finding correlation, mutation testing, chaos/fuzz, executive summary | Customers on the $399 tier |

`quick` finishes in under 15 seconds on a typical repo. `full` targets under 60 seconds.

---

## Troubleshooting

**The action fails with `Cannot find module` on first run.**
Pin `node-version: 22` (or 20) explicitly. GateTest requires Node 20+.

**Auto-repair never opens a PR.**
Three common causes:
1. `auto-fix` is not set to `true`.
2. `ANTHROPIC_API_KEY` is missing from the workflow `env:` block.
3. The findings are config-level (e.g. CI security) with no specific file path the fixer can patch. The fixer needs file-line metadata to apply a fix.

**The gate passes locally but fails on GitHub.**
The runner uses Node 22 by default and a clean working tree. Local environments may have unstaged changes or an older Node. Run `node bin/gatetest.js --suite quick` against a clean checkout locally to reproduce.

**The action takes too long on a large monorepo.**
Use the `working-directory` input to scope the scan to one app at a time, then run multiple jobs in parallel matrix style.

**Permissions error when auto-repair tries to push.**
The workflow needs `pull-requests: write` and `contents: read` (and `contents: write` if you want auto-repair to commit to a branch, not just open a PR from a fork). Add the block to your job:
```yaml
permissions:
  contents: write
  pull-requests: write
  checks: write
```

**The npm package install fails.**
The action falls back to cloning the repo at runtime when `@gatetest/cli` is not yet on npm. This is expected at launch. The fallback path is functionally identical — only marginally slower.

---

## Pricing tiers and what they get you

| Tier | Price | What ships |
| --- | --- | --- |
| Free (OSS) | $0 | Full gate, public repos only |
| Quick Scan | $29 | 4 critical modules, single scan |
| Full Scan | $99 | All 91 modules, single scan |
| Scan + Fix | $199 | 91 modules + iterative Claude fix loop, pair-review of every fix, architecture annotator |
| Nuclear | $399 | 91 modules + per-finding Claude diagnosis, attack-chain correlation, mutation testing, chaos/fuzz, executive summary |
| Continuous | $49/month | Unlimited push-triggered scans |

All paid tiers are pay-on-completion — you are only charged once a scan delivers. Sign up and manage subscriptions at https://gatetest.ai/pricing.

---

## Where things live

- Source repo: https://github.com/ccantynz-alt/gatetest
- Web app and pricing: https://gatetest.ai
- Privacy policy: https://gatetest.ai/legal/privacy
- Live chat support: https://gatetest.ai
