# Pricing Page — DRAFT for Craig's review

> Boss Rule #3 + #6 + #8 all apply.
> Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m on 2026-05-15.
> Edit any tier, any number, any line. The actual page rendering lives at
> `website/app/page.tsx` (Pricing.tsx component) and `website/app/wp/page.tsx`.

## The unified pricing model

Per our discussion: **one set of tiers, three entry points** (developer landing, WP landing, GitHub gate). Billing is the same across all three.

## The four tiers

### Free — $0
**Who it's for:** anyone curious, anyone evaluating, anyone with a hobby project.

What's included:
- Top 3 issues from any scan (Free Preview)
- Full CLI download via npm (when published)
- GitHub gate installs and runs (blocks builds on errors; no auto-fix)
- 101-module engine, plain-language report on the top 3 findings

What's NOT included:
- Auto-fix
- Full report
- Continuous monitoring

### Starter — $29/month
**Who it's for:** indie developers, small WordPress site owners, freelancers.

What's included:
- Everything in Free
- Full scan reports (all 101 modules visible)
- **$10 of auto-fix credit included** (~30 fixes at typical cost)
- Continuous scanning: weekly auto-scan on every project
- Email alerts on new CVEs affecting your stack
- Overage at $0.99 per fix beyond included credit

### Pro — $99/month
**Who it's for:** small teams, agencies, multi-site owners.

What's included:
- Everything in Starter
- **$50 of auto-fix credit included** (~150 fixes)
- Unlimited repos / sites
- Same-day CVE alerts (the 5-hour-exploitation window matters)
- Pair-review agent ($199 one-shot equivalent)
- Architecture-annotator agent
- Overage at $0.50 per fix

### Enterprise — $499/month
**Who it's for:** companies with serious compliance, paid security audits, dedicated SLAs.

What's included:
- Everything in Pro
- **$300 of auto-fix credit included** (~1000 fixes)
- Nuclear tier (mutation testing, chaos, cross-finding correlation, executive summary)
- Dedicated Anthropic rate-limit pool
- Priority email support with 24h response
- Audit log export (SOC2 / lawyer-ready)
- Overage at $0.30 per fix

## One-shot tiers (no subscription)

For users who don't want recurring billing:

| Tier | Price | What you get |
|---|---|---|
| **Quick Scan** | $49 one-shot | Full 101-module scan + plain-language report. No auto-fix included. |
| **Full Audit + Letter** | $129 one-shot | Quick Scan + a written report letter suitable for sharing with developer / host / lawyer. |
| **Emergency** | $499 one-shot | Hacked / broken site? Actionable remediation plan within 1 hour. Includes Nuclear-tier diagnosis. |

## How auto-fix billing works

(Customer-facing copy, plain language)

You pay per fix, not per attempt. We charge from your monthly credit pool. Each fix shows you the estimated cost before it runs (e.g. *"this fix will use ~$0.45 of credit"*).

If your credit runs out, your card is automatically topped up — minimum $20. You set the auto-top-up trigger (default: below $5).

You can cap your monthly spending at any time. Hit the cap → fixes pause, you get an email, you decide whether to raise it.

We never charge more than you authorize. Full transparency in your dashboard at `/account` — every fix is line-itemed with its cost, the issue it fixed, and the PR it produced.

## The honest math behind the pricing

(Internal — not customer-facing. For Craig.)

| Tier | Subscription | Customer expected usage | Our raw Anthropic cost | Our gross margin |
|---|---|---|---|---|
| Starter — light user (5 fixes/mo) | $29 | $1.50 cost | $1.50 / $29 = 5% cost ratio | **$27.50 (95%)** |
| Starter — typical (30 fixes) | $29 | $9 cost | 31% cost ratio | **$20 (69%)** |
| Starter — heavy (60 fixes) | $29 + $30 overage = $59 | $18 cost | 31% cost ratio | **$41 (69%)** |
| Pro — typical (150 fixes) | $99 | $45 cost | 45% cost ratio | **$54 (55%)** |
| Pro — heavy (300 fixes) | $99 + $75 = $174 | $90 cost | 52% cost ratio | **$84 (48%)** |
| Enterprise — typical (700 fixes) | $499 | $210 cost | 42% cost ratio | **$289 (58%)** |

Even at heavy enterprise usage we keep 40-50% gross margin. Light users subsidize heavy users via the subscription baseline. **The Anthropic API genuinely is a profit centre, not just a cost.**

## What needs to happen in Stripe (Boss Rule #6)

These are the Stripe Product configurations you'd create. I'll wire them once you confirm the prices.

```
Product: GateTest Starter
  Price: $29 USD/month recurring
  Tax behavior: inclusive
  Metadata: { tier: "starter", includedFixCreditUsd: "10", overageCentsPerFix: "99" }

Product: GateTest Pro
  Price: $99 USD/month recurring
  Tax behavior: inclusive
  Metadata: { tier: "pro", includedFixCreditUsd: "50", overageCentsPerFix: "50" }

Product: GateTest Enterprise
  Price: $499 USD/month recurring
  Tax behavior: inclusive
  Metadata: { tier: "enterprise", includedFixCreditUsd: "300", overageCentsPerFix: "30" }

Product: GateTest Quick Scan
  Price: $49 USD one-time
  Metadata: { tier: "quick_scan" }

Product: GateTest Full Audit
  Price: $129 USD one-time
  Metadata: { tier: "full_audit" }

Product: GateTest Emergency
  Price: $499 USD one-time
  Metadata: { tier: "emergency" }

Product: GateTest Fix Credit Top-Up
  Price: $20 USD one-time
  Metadata: { type: "credit_topup" }
  Adjustable amount: yes (Stripe Checkout supports per-amount overrides)
```

## What I need from you (Boss Rule)

| # | Boss Rule | What |
|---|---|---|
| 1 | #3 (pricing) | Confirm tier names + prices (or change them; I update the doc + the rendered page) |
| 2 | #6 (Stripe) | Create the 7 products above in Stripe Dashboard; share me the price IDs |
| 3 | #8 (brand copy) | Read the customer-facing copy above; edit any line that doesn't sound right |
| 4 | #9 (public comms) | Confirm "we make margin on Anthropic" framing in the public copy is acceptable (it's transparent; some customers see it as honest, others as off-putting) |

## Suggested rendering changes once you confirm

The existing pricing-card components are at:
- `website/app/components/Pricing.tsx` — main developer landing page tier cards (current: $29 / $99 / $199 / $399 — needs updating to the new model)
- `website/app/wp/page.tsx` — WP landing page tier cards (current: $0 / $19 / $19-mo — needs updating to match)
- `website/app/checkout/...` — Stripe checkout flow

Plus we'll need a new `/account` page showing balance + history + subscription management. Pre-authorized to build once you confirm the model.

## Quick-decision shortcut

If you want to ship the simplest possible version:

1. Confirm: **Free / Starter $29 / Pro $99 / Enterprise $499** + one-shot Quick Scan $49.
2. Drop the Full Audit $129 and Emergency $499 one-shots for v1 — they can ship in v1.1.
3. Drop auto-top-up for v1 — credits run out, customer manually tops up via dashboard. Adds friction but cuts complexity. Add in v1.1.

That's 4 Stripe products. ~10 minutes of your time in Stripe Dashboard. I wire the rest in ~3-4 hours of focused engineering.
