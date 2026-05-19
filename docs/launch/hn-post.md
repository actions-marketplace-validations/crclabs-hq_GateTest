# GateTest — Show HN draft

**Status:** Ready to post. Pick the moment Craig is at his PC with 2-3 hours to monitor replies.

---

## TITLE (pick one, in order of preference)

1. `Show HN: GateTest – 102-module CI gate, gets cheaper as you use it`
2. `Show HN: GateTest – One CI gate that replaces SonarQube, Snyk, ESLint, Cypress, Lighthouse`
3. `Show HN: I replaced 12 QA tools with one gate. Source's open, hosted's pay-per-scan`

Recommendation: **#1.** "Gets cheaper as you use it" is the unfair-advantage hook nobody else has.

---

## URL TO POST

`https://gatetest.ai`

(Not the GitHub repo. The website is the demo. Add the repo link in the body.)

---

## BODY

```
Hi HN — I'm Craig. I shipped GateTest because I was tired of duct-taping
SonarQube + Snyk + ESLint + Cypress + Lighthouse + axe + pa11y + 5 other
tools into every project, each with its own config, dashboard, and bill.

GateTest is one composite GitHub Action that runs 102 static-analysis
modules and uses Claude to repair the findings it can. The interesting
part is that it gets cheaper over time:

  - Deterministic AST and rule-based layers run first (free, fix in
    milliseconds)
  - Claude only runs on patterns nothing else has seen (paid, one shot)
  - Every Claude win is distilled into a reusable recipe
  - Next time the same pattern appears — your repo or someone else's —
    it's handled for free

What you get depends on the tier you bought: a pull request with the
fixes, regression tests pinned to each fix, an architecture-shape
critique, cross-finding attack-chain correlation, and a CTO-readable
executive summary.

What works today:
  - The CLI ships under MIT (npx github:crclabs-hq/GateTest --suite quick)
  - The GitHub Action is live on the Marketplace
    (uses: crclabs-hq/GateTest@v1.1.1)
  - Website-hosted scans at gatetest.ai — paste a URL, get findings,
    one-time per-scan payment via Stripe ($29 / $99 / $199 / $399)
  - 6 real-repo proofs in /docs/proofs (including the Crontech.ai
    monorepo with 754 errors and two critical attack chains)

What doesn't work yet:
  - The npm package isn't published (use the Action or npx for now)
  - Headless-browser modules degrade gracefully on Vercel serverless
    (Chromium can't launch inside the function) — full power requires
    the CLI / a worker / local dev
  - Multi-org GitHub App billing correlation is on the to-do list

Honest limits and the full Known-Issues table live in CLAUDE.md — that
file is the project's source of truth.

Source: https://github.com/crclabs-hq/GateTest
Marketplace: https://github.com/marketplace/actions/gatetest-quality-gate
The Bible: https://github.com/crclabs-hq/GateTest/blob/main/CLAUDE.md

Happy to take hard questions — especially on the recipe-distillation
flywheel and what happens when the per-scan price model meets a customer
whose scan fails mid-way.

— Craig
```

---

## REPLIES — PRE-PREPARED ANSWERS

**"How is this not just snake oil / vapourware?"**

> Fair. Repo is dogfooded — every push to crclabs-hq/GateTest runs
> through GateTest's own gate, see the CI badge. The four real-repo
> proofs in /docs/proofs cover external production codebases (Crontech,
> Gluecron, MarcoReid) with full reports and Anthropic-spend numbers
> attached. Total Anthropic spend across all four: ~$3-4. The flywheel
> is real and the recipe store is on disk. The npm publish is queued
> because I wanted real-customer feedback before committing to a public
> package surface.

**"Why per-scan instead of subscription?"**

> Subscription pricing penalises the careful team that scans 2× a month
> and subsidises the team that scans every commit. Per-scan aligns
> price with actual work done. Continuous scanning ($49/mo) is the
> subscription product for teams that want every push gated — that's
> coming next.

**"How are you not bleeding money on the Anthropic side?"**

> AST + rule + recipe layers handle the majority of findings
> deterministically. Claude only fires on patterns nothing else has
> seen. On the four external real-repo proofs that ran the Nuclear
> pipeline against gatetest + Crontech + Gluecron + MarcoReid, total
> Anthropic spend was ~$3-4. At $399 for Nuclear that's a 100x margin.
> Quick ($29) and Full ($99) tiers don't even invoke Claude on the fix
> path — they're scan-only.

**"What happens if my scan crashes mid-way and I've already paid?"**

> Contact hello@gatetest.ai within 7 days — we re-run the scan at no
> extra cost or issue a credit. Cash refunds are discretionary, not
> automatic. Honest tradeoff: the previous hold-then-capture model
> created a chargeback-abuse vector (pay $99, see report, dispute "didn't
> deliver"). Per-scan upfront with manual support exceptions is what
> every other digital-services SaaS does (Vercel, Linear, etc.).

**"Why should I trust an AI to write fixes?"**

> The fix loop is layered for exactly that reason: AST → rule recipe →
> cached pattern → Claude. Each layer's output passes a syntax gate and
> a scanner re-validation gate before the PR opens. Claude never
> auto-merges — it opens a PR you review. At the $199+ tiers a second
> Claude pair-reviews every fix on a 4-axis rubric. Real outputs in
> /docs/proofs.

**"How is this different from {Snyk Autofix / DeepSource Autofix /
GitHub Copilot Autofix / Sweep / Devin}?"**

> Each of those auto-fixes ONE narrow surface — Snyk fixes dependency
> CVEs, DeepSource fixes their own rule violations, Copilot fixes
> CodeQL findings, Sweep does single-pass code transforms. None of them
> ship the iterative-self-validating-fix-loop + cross-finding correlation
> + per-fix regression test + pair-review combination. The thesis is
> that's what makes the fix actually mergeable, not "interesting demo
> output."

**"Is the CI badge red because your own gate found bugs in itself?"**

> Yes — for ~2 hours after the launch push, we had 73 self-detection
> false-positives where the scanner found its own pattern strings
> inside its own source. Fixed by tightening the scanner-path exclusion
> regex in 5 modules. CI green at commit {LATEST_SHA}. The fact that
> we dogfood enough to surface our own bugs is the point.

---

## SHIPPING CHECKLIST (in order)

- [ ] CI badge green on GitHub (push the 3 ci-fix commits first)
- [ ] gatetest.ai loads and the hero URL scan works in incognito
- [ ] One real Stripe test-card checkout end-to-end succeeds
  (4242 4242 4242 4242, exp 12/30, CVC 123)
- [ ] Post to HN around a known-good window (Tue/Wed/Thu 9-11am PT / 5-7pm PT)
- [ ] First 2 hours: reply to every top-level comment within 10 minutes
- [ ] Don't argue with troll comments — answer the genuine question
  underneath them
- [ ] If a real bug surfaces in comments, file it as a GitHub issue
  immediately and link the comment thread
- [ ] Monitor gatetest.ai health — if a paying user hits a 500, refund
  them from Stripe dashboard within 5 minutes and respond on HN
- [ ] Do not delete negative comments — engage with them honestly

---

## DO NOT SAY ON HN

- "World class" / "10x better" / "AI-powered" superlatives
- Anything implying revenue / customer numbers we don't have
- Anything about competitors that sounds bitter or personal
- "Email hello@gatetest.ai" as the only support channel (looks small)
- Reply to a question with marketing copy
- Lie about what works
