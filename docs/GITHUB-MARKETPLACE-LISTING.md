# GitHub Marketplace Listing — GateTest

> **Instructions for Craig:**
> Go to https://github.com/apps/gatetesthq/edit → Marketplace tab.
> Copy each section below into the corresponding field.
> Fields marked ⚠️ need a decision or asset from you before submission.

---

## App name
```
GateTest
```

---

## Short description
*(140 characters max — shown in search results and the Marketplace card)*

```
102-module AI-powered code quality gate. Catches security issues, bugs, and bad patterns before they reach production.
```

---

## Full description
*(Markdown supported. Shown on the Marketplace listing page.)*

```markdown
## The only gate your repo needs

GateTest scans every push and pull request through **102 specialised modules** in seconds — then posts a commit status and a full report directly to your PR. One check. One decision. Pass or blocked.

### What it catches that your current tools miss

**Security**
- Hardcoded secrets, API keys, tokens — caught before they hit git history
- TLS validation bypasses (`rejectUnauthorized: false`, `verify=False`) that ship to prod
- SSRF vulnerabilities — user-controlled URLs handed to fetch/axios with no validation
- Cookie misconfigs — `httpOnly: false`, weak session secrets, `secure: false`
- SQL injection surfaces, unsafe shell execution, Dockerfile root-user builds

**Reliability**
- N+1 database queries inside loops (Prisma, Sequelize, TypeORM, Mongoose, Knex)
- Race conditions — `fs.exists` → `fs.unlink` TOCTOU, get-or-create lost updates
- Resource leaks — unclosed streams, setInterval handles never cleared
- Async iteration footguns — `forEach(async ...)`, `.filter(async ...)`, unwrapped `.map(async ...)`
- Retry loops with no backoff, no jitter, unbounded retries on 4xx

**Code quality**
- Import cycles that cause runtime TDZ / undefined-import bugs
- Dead code — unused exports, orphaned files, 10+ line commented-out blocks
- Feature flags collapsed into constants (`if (true)`, `const FEATURE_X = true`)
- ReDoS — catastrophic regex patterns that hang your server under load

**AI-generated code patterns**
- Fake fixes — patches that suppress symptoms without fixing the root cause
- Money stored in floats (`parseFloat(price)` → $0.01 rounding drift at scale)
- Datetime timezone bugs — naive `datetime.now()`, JS 0-indexed month traps
- PII logged to console (`logger.info(user)`, `console.log(req.body)`)

**Infrastructure**
- Terraform misconfigs — public S3 buckets, 0.0.0.0/0 on SSH/RDP, unencrypted RDS
- Kubernetes — privileged containers, `:latest` images, missing resource limits
- GitHub Actions — unpinned actions, shell injection via `${{ github.event }}`, missing `permissions:`
- SQL migrations — `DROP COLUMN` without safety, `ADD COLUMN NOT NULL` without default

### How it works

1. **Install** GateTest from the Marketplace (30 seconds)
2. **Push** a commit or open a PR — GateTest scans automatically
3. **See results** — commit status check + detailed PR comment posted within seconds
4. **Fix** the issues — or configure what you care about in `.gatetest.json`

### Pricing

GateTest is **free to install**. Scans are available on [gatetest.ai](https://gatetest.ai):

| Plan | Price | What you get |
|------|-------|-------------|
| Quick Scan | $29 | 4 core modules — fast gate |
| Full Scan | $99 | All 102 modules |
| Scan + Fix | $199 | 102 modules + auto-fix PR |
| Continuous | $49/mo | Scan every push, automatically |

### Where it runs today

Used internally by Crontech.ai and Gluecron.com (real, owner-attributed deployments). Customer quotes will be added after the first cohort of paying customers — we will not publish fabricated or anonymous testimonials.

### Built for AI-assisted teams

GateTest was designed from the ground up for the age of AI-generated code — catching the specific patterns that AI tools produce when they prioritise "it compiles" over "it's correct." The fake-fix detector specifically flags symptom patches: code that silences an error without fixing its cause.

---

**[Start your first scan →](https://gatetest.ai)**

Questions? [hello@gatetest.ai](mailto:hello@gatetest.ai)
```

---

## Category
*(Select up to 2 from GitHub's list)*

**Primary:** `Code quality`
**Secondary:** `Security`

---

## Pricing model
*(Marketplace Settings → Pricing)*

Select: **Free**

> **Why free-to-install:** The GitHub App itself (webhook + commit status) is free. Customers pay on gatetest.ai per scan. This lets you get installs immediately without waiting for GitHub's paid-plan review, which adds weeks. You can add a paid Marketplace subscription later once you have install volume.

---

## Installation URL
```
https://gatetest.ai/github/setup
```

---

## Privacy Policy URL
```
https://gatetest.ai/legal/privacy
```

---

## Terms of Service URL
```
https://gatetest.ai/legal/terms
```

---

## Support URL
*(Can be email or a page)*
```
mailto:hello@gatetest.ai
```

---

## Documentation URL
```
https://gatetest.ai/docs/api
```

---

## Logo requirements ⚠️
*(Craig action — GitHub requires:)*
- **Logo:** 200×200px PNG, no rounded corners (GitHub rounds them), transparent or white background
- **Colour:** Use the GateTest teal/dark theme

---

## Screenshots ⚠️
*(Craig action — GitHub recommends 3-5 screenshots. Suggested shots:)*

1. **PR check passing** — GitHub PR page showing the GateTest check as green ✓
2. **PR comment with issues** — the formatted report comment on a PR with real findings
3. **Module breakdown** — the scan results page on gatetest.ai showing all 102 modules
4. **Blocked PR** — a PR blocked with specific issues listed (secrets, N+1, etc.)
5. **Install flow** — the gatetest.ai/github/setup page

> To get these screenshots: install GateTest on a test repo, push a commit with a known issue (e.g. `const API_KEY = "sk_live_test123"`), and capture the PR page.

---

## What to expect after submission ⚠️

- GitHub reviews new Marketplace listings manually
- Review typically takes **1–3 weeks**
- They check: the app works as described, legal pages are live, install flow works
- You'll get an email when approved or if they need changes

**To speed it up:** Make sure the install flow (gatetest.ai/github/setup) works end-to-end before submission. GitHub reviewers will test it.

---

## Submission checklist

- [ ] Logo PNG uploaded (200×200)
- [ ] At least 3 screenshots added
- [ ] Test install on a fresh GitHub account works
- [ ] `gatetest.ai/legal/privacy` loads
- [ ] `gatetest.ai/legal/terms` loads
- [ ] `gatetest.ai/github/setup` loads and works
- [ ] `GATETEST_GITHUB_TOKEN` set in Vercel env vars (so commit statuses post)
- [ ] Stripe live keys set in Vercel env vars (so payments work)
- [ ] Submit at: github.com/apps/gatetesthq/edit → Marketplace → Submit for review
