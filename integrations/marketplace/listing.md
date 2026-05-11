# GateTest — Marketplace Listing Content

---

## Short description (160 chars — paste verbatim into the Marketplace form)

```
92 AI-powered quality modules scan your repo on every PR. Security, performance, accessibility, and more. Issues found AND fixed automatically.
```

---

## Full description (paste as Markdown into the Marketplace long-description field)

---

### Stop duct-taping 10 tools together. One gate. 92 modules. Zero compromise.

Every engineering team eventually builds the same fragile patchwork: ESLint for style, SonarQube for code quality, Snyk for vulnerabilities, Lighthouse for performance, axe for accessibility, Percy for visual regressions, hadolint for Dockerfiles, tfsec for Terraform, actionlint for CI — each with its own config, its own dashboard, its own billing, and its own false-positive noise.

**GateTest replaces all of them with a single GitHub App.**

Install once. Every push and pull request is scanned by 92 AI-powered modules in under 60 seconds. A pass/fail commit status lands on your PR. If issues are found, GateTest opens an automatic fix PR — diff reviewed, fix explained, ready to merge. You only pay when the scan delivers value.

---

### How it works

1. **Install** — Click "Install" on this page. GateTest is added to your chosen repositories.
2. **Scan** — Every `push` and `pull_request` event triggers a full scan. No configuration required.
3. **Review** — GateTest posts a commit status (✅ pass / ❌ fail) and a detailed comment on your PR with every issue found, severity level, and the exact line.
4. **Fix** — On Scan + Fix and Nuclear tiers, GateTest opens a second PR with automatic fixes applied. Review the diff, merge, done.
5. **Pay on completion** — Your card is held but not charged until the scan finishes and delivers a result. If the scan fails for any reason, the hold is released automatically.

---

### What GateTest catches that your current stack misses

#### Security (12 modules)
- **SSRF** — Detects user-controlled URLs flowing into `fetch`/`axios`/`got` without validation. The bug behind thousands of cloud breaches.
- **ReDoS** — Catastrophic regex patterns: `(a+)+`, overlapping alternations, greedy unanchored `.*`. Finds them before a 10KB input locks your Node process for 30 seconds.
- **Hardcoded secrets** — API keys, JWTs, private keys, Stripe live keys, GitHub PATs — flagged before they reach `git log`.
- **TLS bypass** — `rejectUnauthorized: false`, `verify=False`, `ssl._create_unverified_context()` — the "just for staging" shortcuts that ship to prod.
- **Cookie security** — `httpOnly: false`, `secure: false`, weak session secrets (`changeme`, `keyboard cat`) across Express, Next.js, Django, FastAPI.
- **SQL migration safety** — `DROP COLUMN` without a rollback window, `ADD COLUMN NOT NULL` without a default, `CREATE INDEX` without `CONCURRENTLY`. The ops mistakes that cause 2 AM outages.

#### Code quality (10 modules)
- **N+1 queries** — Database calls inside loops across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-pg, and MySQL2. Detects both block-form (`for`, `while`) and callback-form (`.map`, `.forEach`) loops. Recognises `Promise.all(arr.map(...))` as the correct fix.
- **Error swallowing** — Empty `catch {}` blocks, `.catch(() => {})` on promise chains, `process.on('uncaughtException')` handlers that don't exit, Node callbacks that ignore `err`.
- **Race conditions** — TOCTOU: `fs.exists` → `fs.unlink` on the same path (CVE-class CWE-367). ORM `findOne` → `create` without a transaction or `ON CONFLICT` handler (lost-update bug).
- **Resource leaks** — `fs.createReadStream` never piped to completion, `setInterval` with no `clearInterval`, `WebSocket` opened and abandoned.
- **Import cycles** — Circular dependencies in JS/TS detected via Tarjan's SCC algorithm. The bug that reproduces randomly based on module-cache warmth and test order.
- **Async iteration** — `.filter(async ...)` (Promise is truthy, predicate is meaningless), `.forEach(async ...)` (errors swallowed), `.map(async ...)` not wrapped in `Promise.all`.

#### Money and time safety (2 modules)
- **Float money** — `parseFloat(price)`, `Number(amount)`, `float(total)` on money-named variables — the bug that causes $0.01 drift over a million transactions. Safe-harbour for decimal.js, big.js, dinero.js, Python `decimal`.
- **Datetime timezone bugs** — Python `datetime.now()` without `tz=`, `datetime.utcnow()` (deprecated in 3.12+), JS 0-indexed month literals, `moment()` without `.tz()`.

#### AI and LLM safety (1 module)
- **Prompt injection surfaces** — User input interpolated into prompt templates without delimiters. `NEXT_PUBLIC_*` API keys bundled to the browser. `openai`/`anthropic` calls with no `max_tokens` (unbounded cost DoS). Deprecated model strings (`text-davinci-003`, `claude-v1`).

#### TypeScript safety (1 module)
- **Strictness regressions** — `strict: false`, `noImplicitAny: false`, `skipLibCheck: true` in `tsconfig.json`. `@ts-nocheck` file-wide suppression, unreasoned `@ts-ignore` comments, `as any` casts in exported signatures.

#### Infrastructure (5 modules)
- **Dockerfile** — Root user, `:latest` tags, `curl | sh` pipe installs, baked-in secrets, `chmod 777`, `ADD` with URLs.
- **Kubernetes** — Privileged containers, `hostNetwork: true`, missing resource limits, missing readiness probes, inline secrets in env vars, world-open `LoadBalancer` services.
- **Terraform / IaC** — Public S3 ACLs, `0.0.0.0/0` on SSH/RDP/database ports, unencrypted RDS/EBS/EFS volumes, `Principal: "*"` IAM wildcards.
- **CI workflow security** — Unpinned Actions (`uses: actions/checkout@main` instead of a SHA), `${{ github.event.pull_request.title }}` shell injection, missing `permissions:` blocks, soft-failing the quality gate with `continue-on-error: true`.
- **Shell scripts** — Missing `set -euo pipefail`, `eval` injection, `rm -rf $VAR` without quoting, hardcoded secrets, backtick command substitution.

#### Developer hygiene (5 modules)
- **Feature flags** — `if (true)` / `const FEATURE_X = true` — flags that graduated to "permanently on" and were never cleaned up.
- **PII in logs** — `console.log(password)`, `logger.info(req.body)`, `log.debug(JSON.stringify(user))`. The GDPR violation that ships in every codebase.
- **OpenAPI drift** — Routes in Express / Fastify / Next.js App Router that have no matching spec entry, and spec paths with no handler.
- **Cron expressions** — Invalid field counts, out-of-range values, impossible dates (Feb 30). Harvests from GitHub Actions schedules, Kubernetes CronJobs, Vercel crons, and source-code call sites.
- **Dead code** — Unused exports, orphaned files, 10+ line commented-out code blocks.

---

### Pricing

All plans use **pay-on-completion** — your card is held at checkout but captured only when the scan finishes and delivers a result. If the scan fails for any reason, the hold is released with no charge.

| Plan | Price | What you get |
|------|-------|-------------|
| **Free** | $0/month | 1 scan/month on public repos. No card required. |
| **Quick Scan** | $29 | Security + secrets + syntax + lint (4 modules). Results in under 15 seconds. |
| **Full Scan** | $99 | All 92 modules. Full report in SARIF, JUnit, JSON, and HTML. Under 60 seconds. |
| **Scan + Fix** | $199 | All 92 modules + automatic fix PR opened in your repo, ready to review and merge. |
| **Nuclear** | $399 | Everything + mutation testing, chaos testing, live crawling, and autonomous exploration. |
| **Continuous** | $49/month | All 92 modules scan on every push to every branch. Always-on protection. |

---

### Compared to the alternatives

| Tool | What it covers | Annual cost (typical team) |
|------|---------------|--------------------------|
| SonarQube Cloud | Code quality | $1,500+/year |
| Snyk | Vulnerabilities | $1,200+/year |
| Lighthouse CI | Performance | Free (but manual setup) |
| axe | Accessibility | Free (but separate pipeline) |
| Percy | Visual regression | $600+/year |
| hadolint + tfsec + actionlint | Infrastructure | Free (but 3 more configs) |
| **GateTest Full** | **All of the above + 40 more modules** | **$99 per scan or $49/month** |

---

### Works with any language

GateTest's 9 universal language modules cover Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, and Swift — the same security, reliability, and quality checks adapted for each language's idioms.

---

*GateTest is built and maintained by the GateTest team. Questions? hello@gatetest.ai*

---

## Categories (select on the Marketplace form)

- Code review
- Testing
- Security
- Continuous integration

---

## Pricing plans — configuration reference

(Use these values when entering plans into the Marketplace pricing editor.)

### Free
- **Plan name:** Free
- **Type:** Free
- **Description:** 1 scan per month on public repositories. No credit card required. Perfect for open-source projects.
- **Bullet points:**
  - 1 scan/month on public repos
  - Quick Scan (security + secrets + syntax + lint)
  - PR commit status
  - No credit card required

### Quick Scan — $29
- **Plan name:** Quick Scan
- **Type:** Per-unit or flat monthly
- **Price:** $29
- **Unit label:** scan
- **Description:** Instant feedback on the four highest-signal modules: security, secrets, syntax, and lint. Results in under 15 seconds.
- **Bullet points:**
  - Security vulnerability scan
  - Hardcoded secrets detection
  - Syntax and lint checks
  - PR commit status + comment
  - Results in under 15 seconds

### Full Scan — $99
- **Plan name:** Full Scan
- **Type:** Per-unit or flat monthly
- **Price:** $99
- **Unit label:** scan
- **Description:** Every module, every language. 92 AI-powered checks. SARIF output for GitHub Security. Results in under 60 seconds.
- **Bullet points:**
  - All 92 quality modules
  - SARIF output → GitHub Security tab
  - JUnit + JSON + HTML reports
  - N+1 queries, race conditions, float-money, TLS bypass, and 63 more
  - Results in under 60 seconds

### Scan + Fix — $199
- **Plan name:** Scan + Fix
- **Type:** Per-unit or flat monthly
- **Price:** $199
- **Unit label:** scan
- **Description:** All 92 modules plus an automatic fix PR opened in your repo. Review the diff, merge, done.
- **Bullet points:**
  - Everything in Full Scan
  - Auto-fix PR with AI-generated patches
  - Fix explanations — know what changed and why
  - Review and merge on your schedule

### Nuclear — $399
- **Plan name:** Nuclear
- **Type:** Per-unit or flat monthly
- **Price:** $399
- **Unit label:** scan
- **Description:** The full arsenal: 92 modules + auto-fix + mutation testing + chaos testing + live crawling + autonomous exploration.
- **Bullet points:**
  - Everything in Scan + Fix
  - Mutation testing (validates your tests catch real bugs)
  - Chaos testing
  - Live site crawling
  - Autonomous exploration mode

### Continuous — $49/month
- **Plan name:** Continuous
- **Type:** Flat monthly
- **Price:** $49/month
- **Description:** Scan every push to every branch. All 92 modules. Always-on protection. The equivalent of a full-time QA engineer reviewing every commit.
- **Bullet points:**
  - Scan on every push + PR
  - All 92 quality modules
  - Commit status on every PR
  - Monthly billing, cancel anytime
  - Equivalent to Full Scan on every single push

---

## App configuration reference

(Values to confirm on the GitHub App settings page before submitting the listing.)

| Setting | Value |
|---------|-------|
| **Setup URL** | `https://gatetest.ai/github/setup` |
| **Webhook URL** | `https://gatetest.ai/api/webhook` |
| **Callback URL** | `https://gatetest.ai/api/github/callback` |
| **Webhook events** | `push`, `pull_request` |
| **Contents permission** | Read |
| **Pull requests permission** | Read & write |
| **Commit statuses permission** | Read & write |
| **Issues permission** | Read & write |
| **Metadata permission** | Read |
