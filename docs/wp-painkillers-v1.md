# WordPress Side Product — v1 Painkillers Roadmap

> Authorisation: Craig 2026-05-13 — *"If we can make money by adding it to WordPress that's what we do… we'll take the opportunity to figure out if there's any major painkillers for WordPress users that we can add to it we're here to solve problems."*
> Boss Rule D — explicit go-ahead recorded.

## The thesis

**43% of websites run WordPress. Most owners aren't developers. Their pain is real, recurring, and money-attached.** We win by being the only tool that unifies QA + security + performance + accessibility + SEO + content for the WordPress audience, with plain-language reports and pay-per-scan pricing.

Wordfence, Sucuri, Jetpack, iThemes, WP Rocket, Yoast — every competitor solves ONE axis. We solve all of them in one scan.

## Painkillers vs vitamins

A **painkiller** is something they actively pay to make go away. A **vitamin** is "nice to have."

This product ships painkillers only.

### Top 10 WordPress painkillers (Wordfence + Sucuri reports + WP-Tavern discussions, 2024-2026)

| Rank | Pain | Annual revenue lost / spent | What it looks like |
|---|---|---|---|
| 1 | **"My site got hacked / has malware"** | $50M+/yr to Sucuri alone | Defaced homepage, malicious redirects, spam ads, blacklisted by Google |
| 2 | **"Plugin update just broke checkout / contact form"** | Lost sales, ~weekly | The site looks fine but the conversion path is dead |
| 3 | **"Site is slow → Google rankings dropped"** | 10-40% organic traffic loss | Core Web Vitals red; PageSpeed Insights below 50 |
| 4 | **"GDPR / ADA accessibility complaint received"** | $5K-$100K+ legal exposure | Lawyer letter; needs immediate audit + remediation |
| 5 | **"Brute-force spam on /wp-admin"** | Hours of support load | 1000s of 401s in logs daily; resource starvation |
| 6 | **"PHP version forced upgrade by host"** | Site goes white-screen | Deadline panic; plugins incompatible with PHP 8.2+ |
| 7 | **"No tested backup — host had an outage and I lost a week"** | Catastrophic occasionally | Often discovered AFTER it's too late |
| 8 | **"Comment spam flood overwhelming moderation"** | Daily annoyance | Akismet missed 100s; manual cleanup |
| 9 | **"Performance Score < 50 hurting AdSense / Amazon Affiliates"** | Direct revenue hit | Ad load delayed → measurably lower CTR |
| 10 | **"Plugin developer abandoned → no updates → CVE risk"** | Strategic risk | Plugin hasn't shipped in 18 months; using it anyway |

GateTest's existing 94-module engine already handles 1, 3, 4, 9, 10 with general modules (`security`, `performance`, `accessibility`, `seo`, `dependencies`, `webHeaders`, `tlsSecurity`, `cookieSecurity`). What we need to ADD is the WordPress-specific layer that converts those scans into WP-owner language and surfaces the WP-specific attack surfaces.

## v1 module list (this session)

| Module | Painkiller served | Implementation |
|---|---|---|
| `wpExposedFiles` | #1 hacked / #10 abandoned plugin | HEAD requests to known-bad paths: `wp-config.php.bak`, `wp-config.php.swp`, `debug.log`, `error_log`, `.git/HEAD`, `.DS_Store`, `.env`, `README.html`, `license.txt`, `readme.txt`. Each hit is a real attack vector. |
| `wpVersionLeak` | #1 CVE enabler | Checks `/readme.html`, meta generator tag, `/wp-includes/css/dist/version.css?ver=*`, RSS generator. Knowing WP version is half the work for a CVE attacker. |
| `wpXmlrpcExposed` | #1 + #5 DDoS / brute force amplifier | Checks if `/xmlrpc.php` returns SOAP response. Pingback amplification + auth-bypass route. |
| `wpUserEnumerate` | #5 brute-force enabler | Checks `/?author=1` redirect, `/wp-json/wp/v2/users` JSON leak, `/author/admin/` 200. If admin username is known, attack is half-done. |
| `wpAdminProtection` | #5 brute-force | Checks `/wp-admin` and `/wp-login.php` reachability + cookie hardening + WAF / rate-limit signals. |

## v2 module list — 3/10 shipped, 7 deferred

### Shipped — v2 batch (2026-05-13)

| Module | Painkiller |
|---|---|
| `wpPluginCveCheck` | #10 — enumerate plugins via fingerprinting, cross-reference against curated CVE list (13 high-impact 2024-2026 CVEs inline) |
| `wpMalwarePatterns` | #1 — scan rendered homepage for known injection patterns (eval(atob), hidden iframes, base64 payloads, PHP-eval leak, deny-list of known-malicious domains) |
| `wpUserEnumerate` | #5 — checks 3 username-leak vectors: `/?author=1` redirect, `/wp-json/wp/v2/users` REST API, `/author/admin/` probe |

### Shipped — v3 batch (2026-05-13)

| Module | Painkiller |
|---|---|
| `wpAdminProtection` | #5 — login-page WAF / rate-limit / 2FA detection + cookie hardening + bad-credential probe response shape |
| `wpPhpVersionEol` | #6 — detects PHP version via X-Powered-By + error-page fingerprint; flags EOL versions with months-since-EOL count |
| `wpThemeAbandonment` | #10 — detects active theme from `wp-content/themes/<slug>/style.css` URL; cross-references against curated deprecated/CVE list |
| `wpBackupValidation` | #7 — detects backup plugins + probes for publicly-exposed backup files (UpdraftPlus, BackWPup, Duplicator, AIOWP, manual backup.zip/sql in webroot) |

### Still deferred (v4 candidates)

| Module | Painkiller |
|---|---|
| `wpCommentAntiSpam` | #8 — check if comments accept anonymous links, presence of Akismet/Honeypot |
| `wpCoreWebVitalsLive` | #3 / #9 — Lighthouse against the real URL, surface CrUX field data |
| `wpAccessibilityWcag` | #4 — axe-core scan over real DOM (already have `accessibility` module; wire for WP URLs) |

## Pricing (placeholder — Boss Rule #6 pending)

| Tier | Price | What you get |
|---|---|---|
| **Health Check** | $19 one-shot | v1 modules + plain-language report (~30 findings on average WP site) |
| **Full Audit** | $49 one-shot | v1 + v2 modules + written summary letter suitable for sharing with developer / host / lawyer |
| **Continuous** | $19/mo | Weekly scan + email alerts on new CVEs affecting your plugins / theme |

## Brand contract

- **Subdomain:** `wp.gatetest.ai` (DNS pending — Boss Rule #4)
- **In code:** lives under `/wp` routes for now until DNS lands
- **Voice:** plain English. No "module fired" or "AST traversal." Sentences like "Your site is leaking the file `wp-config.php.bak` — anyone can read your database password by visiting `yoursite.com/wp-config.php.bak`. Fix: delete the file from your server."
- **Cross-promotion:** "Built on the GateTest engine" small footer link. Cross-sell only, not co-marketing.

## What this DOESN'T do (honesty)

- **No agent / plugin install required.** Scan is from outside, anonymous, no auth. That means anything that requires admin access (real plugin list, theme name, user roles) is best-effort fingerprinting, not authoritative.
- **No malware removal service.** We tell you WHAT'S wrong; we don't clean it. Cleanup is a manual step or a referral.
- **No backup service.** We tell you if you don't have one; we don't make backups.
- **No firewall service.** We tell you if you're exposed; we don't block attackers.

These limitations are deliberate — they keep us out of Wordfence / Sucuri / Jetpack's core moats and let us focus on the diagnosis layer where unification beats specialisation.

## Open Boss Rule items for full launch

| # | Item | Owner |
|---|---|---|
| 1 | Stripe products: `WP Health Check $19`, `WP Full Audit $49`, `WP Continuous $19/mo` | Craig (Boss Rule #6) |
| 2 | DNS for `wp.gatetest.ai` → same Vercel project | Craig (Boss Rule #4) |
| 3 | Brand copy review on `/wp` landing page before public traffic | Craig (Boss Rule #8) |
| 4 | WordPress plugin directory listing for the eventual "WP Health Check" companion plugin (optional, future) | Craig (Boss Rule #8) |
