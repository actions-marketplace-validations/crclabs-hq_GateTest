# Cross-promotion copy — DRAFT for Craig's review

> All copy below is a draft (Boss Rule #8 — brand / marketing).
> Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m on 2026-05-13.
> Edit any line. The code already points at these strings — change the
> strings in this doc + the matching component file and rebuild.

## Three taglines

| Product | Draft tagline | Where it lives in code |
|---|---|---|
| **GateTest** | *"AI writes fast. GateTest keeps it honest."* (already in production footer) | `website/app/components/Footer.tsx:59` and the existing Hero |
| **Gluecron** | *"Git hosting built for the era of AI code agents."* | `website/app/components/StackBar.tsx` + `website/app/stack/page.tsx` |
| **Crontech** | *"Cron + uptime monitoring that tells you the second something breaks."* | `website/app/components/StackBar.tsx` + `website/app/stack/page.tsx` |

### Why I picked these lines

**GateTest** — already battle-tested in production. No reason to change.

**Gluecron** — I don't fully know your final Gluecron pitch. The line I picked emphasises the AI-agent angle because (a) it's what makes Gluecron different from GitHub right now, (b) the agent era is genuinely accelerating and the buyer feels it, (c) it doesn't trash-talk GitHub, which would look petty. Honest alternative drafts:
- *"A git host where your code is yours and your webhooks fire on time."*
- *"The git host the GateTest team runs on."* (uses our own product as a trust signal)
- *"Git hosting without the politics."*
- *"A git host built by developers who got tired of the alternatives."*

**Crontech** — I don't know whether Crontech is purely cron-monitoring, or full uptime monitoring, or both. I went with "Cron + uptime" because the name implies the cron half and uptime is the natural pairing. If Crontech is something different (e.g. CI scheduling, batch-job orchestration), the line is wrong and needs to be your call.

## Where the cross-promo appears

### Layer 1 — StackBar component (every page footer)
**File:** `website/app/components/StackBar.tsx`
**Embedded in:** `website/app/components/Footer.tsx`
**What:** three equal-weight cards, "Part of the same stack" header, "Built by the same team" footer. Highlights the current product with a subtle "you are here" tag.

### Layer 2A — Contextual mention on `/wp` (WP customers → Crontech)
**File:** `website/app/wp/page.tsx`
**Where:** between the "What we don't do" section and the final CTA
**What:** an amber-tinted card explaining that GateTest catches issues at scan time, Crontech catches them at run time. Single link to crontech.ai.

### Layer 2B — Gluecron in the developer Integrations grid
**File:** `website/app/components/Integrations.tsx`
**What:** new "Git Hosts" panel above the CI/CD panel. GitHub, GitLab, Bitbucket as text chips; Gluecron as a clickable accent-coloured chip with "(built by the same team)" tag.

### Layer 3 — Dedicated `/stack` page
**File:** `website/app/stack/page.tsx`
**Linked from:** the StackBar cards (each card click goes to the product, but the dedicated page is reachable via direct URL or future nav link). Title: "One team, three products."

## What I deliberately DIDN'T do

- **No popup modals.** Three cards in a footer is fine. A modal asking "have you tried Crontech?" is annoying.
- **No cross-account data sharing.** A GateTest signup never auto-creates a Gluecron account. Boss Rule #9.
- **No bundle pricing.** Each product priced independently. Bundles read as desperate.
- **No "from the makers of"-style co-promotion in the Hero.** That dilutes the primary product pitch. Save it for the footer and the dedicated stack page.

## How you tweak the copy

Each tagline is duplicated in 2-3 places. To change a Gluecron line, search for:
```
git grep "Git hosting built for the era"
```
and update all hits in one pass. Same for Crontech and GateTest. The matches are intentional — I'd rather have copy duplicated than abstracted into a constants file that's invisible to future-Craig at edit time.

## Reciprocal placement on Gluecron + Crontech sites

I don't have MCP access to those repos. **You'll need to add reverse-direction promotion blocks on `gluecron.com` and `crontech.ai`** pointing back at GateTest. Without reciprocal links the flywheel only spins one way.

Same rough treatment in reverse:
- Gluecron footer: small StackBar with GateTest tagline "*Audit anything you push.*"
- Crontech footer: small StackBar with GateTest tagline "*The audit before deploy.*"

## Boss Rule items this commit triggers

| # | Item | Status |
|---|---|---|
| #8 | Brand copy on `/`, `/wp`, `/stack`, footer | Draft pushed for review — Craig approves the words before they go to production |
| #9 | Public-facing comms (Crontech + Gluecron mentions) | Same — drafted, not live until approval |

Vercel preview will deploy automatically. If you read the copy on the preview and it sounds wrong, edit this file + the matching component, and push again.
