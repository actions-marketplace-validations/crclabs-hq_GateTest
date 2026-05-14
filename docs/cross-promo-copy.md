# Cross-promotion copy — DRAFT for Craig's review

> All copy below is a draft (Boss Rule #8 — brand / marketing).
> Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m on 2026-05-13.
> Edit any line. The code already points at these strings — change the
> strings in this doc + the matching component file and rebuild.

## Three taglines (FINAL — confirmed by Craig 2026-05-13)

| Product | Tagline | Where it lives in code |
|---|---|---|
| **GateTest** | *"AI writes fast. GateTest keeps it honest."* | `website/app/components/Footer.tsx:59` and the existing Hero |
| **Gluecron** | *"The git host built around Claude."* | `website/app/components/StackBar.tsx` + `website/app/stack/page.tsx` |
| **Crontech** | *"AI-native. Edge-first. Zero ops."* | `website/app/components/StackBar.tsx` + `website/app/stack/page.tsx` |

### Positioning notes

- **Gluecron** is the git host (matches the Bible's Strategic Direction section). Differentiated from GitHub by being Claude-aware from day one — agent-friendly API, no AI-training opt-in, etc.
- **Crontech** is the edge-runtime / scheduled-job platform — NOT uptime monitoring. The earlier draft assumed it was uptime monitoring; the corrected positioning is "scheduled jobs and background work running at the edge with zero infra."

### Previous-draft archive (kept for reference)

The first draft of this doc had Gluecron and Crontech swapped. Craig confirmed the correct mapping on 2026-05-13 via session 016MgmXrLw4Y35fnyTBLS96m. If anyone reading this finds an outdated "Crontech = uptime monitoring" reference anywhere in the codebase, it's stale and should be updated.

## Where the cross-promo appears

### Layer 1 — StackBar component (every page footer)
**File:** `website/app/components/StackBar.tsx`
**Embedded in:** `website/app/components/Footer.tsx`
**What:** three equal-weight cards, "Part of the same stack" header, "Built by the same team" footer. Highlights the current product with a subtle "you are here" tag.

### Layer 2A — Contextual mention on `/wp` — REMOVED

Originally drafted a Crontech contextual mention framed as "catches issues at run time" (uptime monitoring). After Craig clarified Crontech is actually an edge-runtime / scheduled-job platform, the audience overlap with WordPress owners is near zero — they don't run scheduled jobs at the edge, they manage CMS sites. **Mention removed.** WP owners still see Crontech in the StackBar footer (Layer 1), which is appropriate exposure without forcing a poor product fit.

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
