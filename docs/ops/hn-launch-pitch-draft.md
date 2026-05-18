# HN Launch Pitch — DRAFT for Craig's review

**Status:** DRAFT. Tone-honest, no overclaim. Craig edits before posting.

**Authorization:** Brand/marketing changes are Boss Rule #8 — Craig owns the wording. This file is a recommendation, not auto-published anywhere.

---

## What to NOT say

- ❌ "Patent Pending" (you haven't filed)
- ❌ "Architectural Memory" (not shipped — the centralised cross-scan piece is Tier-2 Boss Rule)
- ❌ "AI security platform" (too generic, HN will yawn)
- ❌ "Revolutionary" / "Disruptive" / "Next-generation" (HN allergic)
- ❌ Module count claims that disagree with the code (`gatetest --list` must match the marketing number)

## What to actually say

The two things that are real, shipped, and defensibly differentiated:

1. **Surgical-diff fix mode** — Claude only sees the ± 20 lines around an issue, never the whole file. Bytes outside the splice are byte-identical by construction. Nobody else ships this.
2. **Contextual grounding** — every fix prompt is prepended with the customer's own `CLAUDE.md` / `AGENTS.md` / `README.md` / `.cursorrules`. Claude follows the customer's stack instead of suggesting their preferred patterns.

The two things that are real and competitive but not unique:

3. **90 QA modules** in one scan (security / a11y / perf / supply chain / etc. — replaces 10+ point tools)
4. **Pay-on-completion** — card hold, only charged after delivery. No-fix = no charge.

---

## Title (60-80 chars)

Pick ONE — A/B test in your head:

- **Show HN: GateTest — the auto-fixer that doesn't reformat your code** (54 chars)
- **Show HN: 90-module QA gate with surgical-diff AI fixes (zero mutation)** (72 chars)
- **Show HN: Auto-fix PRs that respect your project's conventions** (60 chars)

My pick: the first one. The "doesn't reformat your code" hook directly counters every developer's #1 complaint about AI fixers.

---

## Body — ~300 words, plain HN style

```
Hi HN. I'm Craig, solo dev from NZ. I built GateTest because every AI
auto-fixer I tried — Copilot Autofix, Sweep, Claude in Cursor — kept
"improving" code I didn't ask them to touch. One fix to a null check
would come back with 40 lines of reformat. Reviewing the PR took
longer than fixing the bug manually.

GateTest takes a different approach. When it fixes an issue at line
138, it sends Claude ONLY lines 118-158 of the file. Never the whole
file. Then it splices the replacement back in. Lines 1-117 and 159-end
are byte-identical to the original because they were never sent. The
reformat problem becomes structurally impossible.

It also reads your project's own conventions (CLAUDE.md, AGENTS.md,
ARCHITECTURE.md, README.md, .cursorrules — first 2KB each) and
prepends them to every fix prompt. So Claude stops suggesting Mongo
when your README says Postgres.

90 scanning modules in one CLI / API / web run — security,
accessibility, supply-chain, IaC, AI code review, mutation testing,
plus a "fake-fix detector" that catches symptom-patching. Replaces
Snyk + ESLint + axe + Lighthouse + Semgrep + Dependabot
in a single gate decision: PASS or BLOCKED.

Pricing: $29 Quick Scan, $99 Full Scan (all 102 modules), $199 Scan+Fix
(adds pair-review + architecture annotations), $399 Nuclear (real
Claude diagnosis + cross-finding attack-chain correlation). Card hold
at checkout, only charged after delivery. CLI is free (BYO Anthropic
key).

Standard install:
  npm install -g gatetest                    (once published)
  curl -sSL https://gatetest.ai/install.sh | bash   (CI gate today)
  https://gatetest.ai                        (paid web scans today)

Repo is open source: https://github.com/ccantynz-alt/gatetest

Honest caveats below. I'm here all day to answer questions.
```

---

## Caveats (post as a top-level comment, or in the body)

The "honest caveats" comment kills the worst HN takedowns before they start:

```
A few things I want to call out before HN beats me to it:

- The surgical-diff mode is one week old. ~10 real fixes have run
  through it across 4 customer repos. I'm watching closely for edge
  cases. If you find one, file an issue and I'll fix it tonight.

- The 90-module count includes modules at different maturity levels.
  ~60 are "I'd bet my company on this." ~25 are "good and improving."
  ~5 are "infant — pattern-match level only." Module list is at
  gatetest.ai/modules with maturity tags.

- Pricing is per-scan, not per-month. The Continuous tier is on the
  roadmap but not built — don't sign up for that yet.

- I'm solo. Expect ~4 hour response time during NZ daylight, longer
  overnight. If GateTest opens a broken PR on your repo, I'll personally
  refund and fix it myself. Pay-on-completion means you've taken on
  near-zero risk to try it.

- BYOK CLI is free forever — if you don't want to pay, install via
  npm and pay Anthropic directly for your fix budget.

Ask anything.
```

---

## Tags

Suggested HN flair (don't add — HN convention is no tags in titles, but check the "Show HN" rules):

- Show HN (mandatory if posting under Show HN)

## Pre-launch checklist before posting

- [ ] PR `claude/fix-scan-timeout-issues-UJWLi` → main is **merged** (so customers see the shipped surgical mode, not the broken whole-file)
- [ ] `gatetest.ai` is live and the $29 Quick Scan completes end-to-end (smoke test yourself with test card 4242 4242 4242 4242)
- [ ] `npm install -g gatetest` works (publish completed)
- [ ] Stripe production webhook is set and secret matches
- [ ] Sentry config is either fixed or removed (deploy log clean)
- [ ] Rate limiter is live on `/api/checkout` + `/api/scan/run` + `/api/scan/fix`
- [ ] Status page exists at gatetest.ai/status (Anthropic / Stripe / GitHub health)
- [ ] Anthropic limit increase request submitted (if you're on default tier)
- [ ] You have 8 hours of clear schedule (HN front-page traffic peaks in the first 6 hours)
- [ ] Coffee, water, snacks within arm's reach

## Best posting time

- Tuesday-Thursday, 8:00-10:00 EST (1pm-3pm UTC, 1am-3am NZ next day — bad for you)
- OR Sunday evening US time = Monday daytime NZ (better for solo founder timezone)

Worst time: Friday afternoon US (weekend dead zone).

## After posting

- Refresh the front page once every 15 min for the first 2 hours
- Reply to every comment within 30 min for the first 4 hours
- Don't argue. Acknowledge, fix, ship a follow-up commit linked in a reply.
- If trolled, ignore — DON'T feed the dragon. HN moderators will downvote.
- If a comment finds a real bug, FIX it in real-time and post the commit link in your reply. This converts critics into champions.
