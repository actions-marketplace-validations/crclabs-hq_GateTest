# PR #69 — Merge Audit

**Branch:** `claude/wp-side-product-launch` → `main`
**Commits:** 8
**Files changed:** ~25
**Lines:** ~2,500 added, ~80 removed
**Risk:** Medium (large surface area, but all additive)

## What this PR does — 30-second version

Ships the WordPress side product (v1+v2+v3 = 10 WP-specific modules), plus the cross-promotion layer (StackBar footer, /stack page, Gluecron link in Integrations panel). Module count: 91 → 101. Tests: +77 new, all green.

## What lands when this merges

### New WordPress modules (10)

| Module | What it does | Painkiller |
|---|---|---|
| `wpExposedFiles` | Probes 25 known-bad paths (wp-config.php.bak, .git/HEAD, .env, backup.sql, etc.) | #1 hacked sites |
| `wpVersionLeak` | Detects WP version via 5 known leak vectors (readme.html, meta generator, RSS, etc.) | #1 CVE enabler |
| `wpXmlrpcExposed` | Two-probe detector for xmlrpc.php — escalates to error on pingback.ping | #1 + #5 DDoS / brute force |
| `wpPluginCveCheck` | Fingerprints installed plugins, cross-references against 13 curated 2024-2026 CVEs | #10 abandoned plugins |
| `wpMalwarePatterns` | Scans rendered HTML for 8 malware signatures + 11 known-bad domain deny-list | #1 hacked sites |
| `wpUserEnumerate` | Checks 3 username-leak vectors (?author=1, REST API, /author/admin/) | #5 brute force |
| `wpAdminProtection` | Probes /wp-admin + /wp-login.php for WAF / 2FA / cookie hardening | #5 brute force |
| `wpPhpVersionEol` | Detects PHP version via X-Powered-By, flags if EOL with months-since-EOL count | #6 PHP forced upgrade |
| `wpThemeAbandonment` | Detects active theme, cross-references against curated deprecated/CVE list | #10 abandoned themes |
| `wpBackupValidation` | Detects backup plugins + probes for publicly-exposed backup files | #7 no backup catastrophe |

9 of 10 top WordPress painkillers covered.

### New routes

- **`/wp`** — WordPress landing page (plain-language, 8 painkiller cards, 3 pricing cards, "what we don't do" section)
- **`/stack`** — "One team, three products" page (GateTest + Gluecron + Crontech)
- **`/api/wp/scan`** — POST endpoint that takes a URL, runs the `wp` suite, returns plain-language report
- **`/wp` Free Preview** — top 3 findings free; full report gated on Stripe checkout (NOT YET WIRED — your billing decision)

### New / changed components

- **`StackBar.tsx`** — three product cards, equal weight, in every page footer
- **`Footer.tsx`** — integrated StackBar above the existing 4-column grid
- **`Integrations.tsx`** — new "Git Hosts" panel with Gluecron prominent
- **`/wp` page** — landing + scan input + pricing (placeholder prices)

### Tests

- `tests/wp-modules.test.js` — 25 cases (v1 modules)
- `tests/wp-modules-v2.test.js` — 29 cases (v2 modules)
- `tests/wp-modules-v3.test.js` — 23 cases (v3 modules)
- Total: 77 new tests, all green
- No changes to existing module tests; existing 1242 tests still green

### Module count

- Registry: 91 → 101 modules
- `wp` suite (new): 18 modules tuned for live-URL probing

### Documentation

- `docs/wp-painkillers-v1.md` — strategic rationale + module roadmap
- `docs/cross-promo-copy.md` — single source of truth for taglines + cross-promo wording

### Bug fix included

The same `@lib/` → `@/app/lib/` import-path correction that's in PR #70. Duplicate but harmless; git will dedupe on merge.

## What this DOESN'T touch

- ❌ No Stripe pricing changes (placeholder prices on `/wp` page, real billing pending your sign-off)
- ❌ No Boss-Rule actions taken without auth
- ❌ No production deploys
- ❌ No DNS changes
- ❌ No npm publish
- ❌ Existing developer-side modules unchanged
- ❌ Existing scan APIs unchanged (`/api/scan/run`, `/api/scan/fix`) — only added the WP wrapper

## Boss-Rule items that ARE still pending (separate from merge)

| # | Item | Notes |
|---|---|---|
| #8 | Brand copy on `/wp`, `/stack`, StackBar, Integrations | Drafts shipped; Craig reviews on Vercel preview after merge, edits in place if needed |
| #6 | Stripe products: WP pricing tiers | None wired; placeholder prices on the landing page until you confirm the model |
| #4 | DNS `wp.gatetest.ai` → Vercel | Site lives at `/wp` for now; subdomain whenever you want |

Merging this PR does NOT trigger any of those — they're separate manual actions.

## Risk assessment

**Where it could go wrong on merge:**

1. **Vercel build fails because of the @lib/ alias bug** — already fixed in this PR (commit `9248cba`), AND in PR #70. Either-or both is fine.
2. **Visual regression on the homepage footer** — StackBar adds height. If you don't like the look, edit `StackBar.tsx`; no engine code touched.
3. **Module count discrepancy in marketing copy** — Hero / Pricing components still say "67 modules" in some places. Should be updated to 101. (Not in this PR — a follow-up.)

**No engine logic changed.** Worst case rollback is `git revert` on the merge commit.

## Action

Merge after PR #70. Vercel rebuilds. WordPress side product goes live at `/wp`. Cross-promo footer appears site-wide. No customer-charging changes (you still control when billing flips on).

You should expect to spend ~15 minutes after merge:
- Visit Vercel preview, scan the `/wp` page copy
- Visit `/stack` page, confirm Gluecron + Crontech taglines read correctly
- Edit `docs/cross-promo-copy.md` if any words feel off, push the fix

That's it.
