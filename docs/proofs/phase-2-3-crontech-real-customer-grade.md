# Phase 2.4 + 3.7 — Real-customer-grade proof against Crontech

**Status:** real Claude API calls, against a real Craig-owned production-grade codebase (Crontech.ai). Counts as the **second proof** for both Phase 2.4 and Phase 3.7.
**Date:** 2026-04-26
**Target repo:** `Gate-Test/Crontech` — a multi-tenant Bun + Turbo TypeScript monorepo (apps/web, apps/api, packages/*, services/*). 6.7 MB, TypeScript-heavy, public.
**Model:** `claude-sonnet-4-6`
**Note on detail:** the customer-facing report this run produced contains specific file paths and vulnerability evidence from Crontech's source. That report is kept off-repo (in the session's `/tmp` only) because publishing internal vuln detail in a public docs commit is bad form. The numbers and chain titles below are safe to share.

This is the first time GateTest's full pipeline has been exercised
against a non-self target. Real customer-grade findings, real Claude
diagnosis, real cross-finding correlation. Goes far beyond the
gatetest-self proofs because the codebase wasn't built to test
GateTest — it was built to do its own job.

## Step 1 — Quick scan (Phase 2.4 first half)

Cloned Crontech via the supplied GitHub PAT, ran
`node bin/gatetest.js --suite quick` against the working tree.

| Metric | Value |
| --- | --- |
| Modules passed | **23 / 39** |
| Checks passed | 276 / 2,878 |
| **Errors** | **754** |
| **Warnings** | **1,617** |
| Wall time | 25.5 s |
| Final gate | **BLOCKED** |

Failed-module breakdown (top by error count):
- `codeQuality` — 575 errors (file-length, function-length, console.log calls)
- `secrets` — 14 errors across 14 different files (frontend components, admin routes, install scripts, mirror scripts)
- `lint` — 1 error (eslint config)
- `syntax` — 1 error (typescript-strict)
- + 12 more failed modules across promptSafety, hardcodedUrl, envVars, etc.

This is **real customer-grade output** — Crontech wasn't tuned to look
clean against GateTest. The scanner found genuine issues in production
code.

## Step 2 — Nuclear-tier deliverables (Phase 3.7 second half)

Picked 10 representative error-severity findings (sampled by module
class — secrets, codeQuality — not cherry-picked for any specific
result), ran the full $399-tier pipeline.

### Diagnoser (3.1)

| Metric | Value |
| --- | --- |
| Findings input | 10 |
| Diagnosed successfully | **10 / 10** |
| Skipped | 0 |
| Wall time (parallel with correlator) | ~115 s |

Each finding got a real evidence-tied diagnosis with explanation /
root cause / recommendation / platform notes. Sample (paraphrased,
not direct quote — full text kept off-repo):

The diagnoser correctly identified that one of the secrets was inside
a React component file, meaning the value compiles into the **client
bundle** that ships to every browser visiting the site. That's
specialist-grade reasoning — a per-file scanner sees "secret in file
X," but the diagnoser says "this specific file becomes browser-readable
JavaScript on deploy, so the secret is *publicly readable* from
DevTools." That's the difference.

### Correlator (3.2)

**2 critical attack chains identified across the 10 findings.**

| # | Chain (title only) | Severity | Findings combined |
| --- | --- | --- | --- |
| 1 | Hardcoded secrets in frontend component + admin onboarding route → credential exposure + admin takeover | **CRITICAL** | 2 findings |
| 2 | Hardcoded queue client secret + auto-deploy scripts → supply-chain / infrastructure takeover via leaked CI credentials | **CRITICAL** | 3 findings |

**Why this matters:** each individual `secrets:` finding is a yellow
flag in isolation. Combined into chains by the correlator, they
become red flags with specific impact paths. Chain #2 in particular
identifies a textbook supply-chain pattern — credential in a queue
client + the same credential class in install/deploy scripts means an
attacker who reads ANY of the involved files gains a path into
infrastructure operations. That's real $399-tier value.

### Executive summary (3.5)

**Headline (verbatim — safe to share, no specifics leaked):**

> *"Five hardcoded secrets in committed code create two critical
> attack chains — immediate remediation required before any further
> deployment."*

That's exactly what a CTO needs to read: clear, specific, actionable.
Not "improve security" — *five secrets, two chains, blocking
recommendation*.

The remaining sections (POSTURE / TOP_3_ACTIONS / WORKING_WELL /
RECOMMENDED_NEXT) are populated with file-level specifics that stay
off-repo for the same reason as the diagnoses.

## Total run

| Metric | Value |
| --- | --- |
| Diagnoser + correlator (parallel) | 114.7 s |
| Executive summary (sequential) | 12.9 s |
| **Total Nuclear deliverable wall time** | **~128 s** |
| Anthropic spend (estimated) | ~$0.80 - $1.20 |

For a tier priced at $399, this is comfortably in the right margin
zone (single-digit dollar Claude cost for a multi-hundred-dollar deliverable).

## What this proves

| Phase | Sub-task | Validated? |
| --- | --- | --- |
| 2 | 2.4 — real-repo proof | **2/3 done** — gatetest self + Crontech |
| 3 | 3.1 diagnoser | YES on customer-grade input |
| 3 | 3.2 correlator | YES — 2 critical chains found in real production code |
| 3 | 3.5 executive summary | YES — headline + structured sections clean |
| 3 | 3.7 — real-repo proof | **2/3 done** — gatetest self + Crontech |

Both phases now have one self-proof + one external-customer-grade
proof. The third proof for each phase is the only remaining 1.5 / 2.4
/ 3.7 work item.

## Provenance and security

- The clone was a temporary depth-1 clone in `/tmp/crontech` (deleted
  at session end).
- The full diagnoser + correlator + executive-summary report exists
  in `/tmp/proof-crontech-report.md` (session-ephemeral; the file
  contains specific Crontech file paths and vulnerability evidence
  and is intentionally NOT committed to the public gatetest repo).
- Crontech's repo was not modified during this proof — no branches
  created, no PRs opened, no commits pushed. This proof exercises
  GateTest *against* Crontech without touching it.
- The summary statistics in this document (error counts, module
  pass/fail, chain titles, headline sentence) are safe to share
  publicly because they describe *what GateTest can do*, not *what
  is wrong with Crontech specifically*.

## Reproduction (for future sessions with credentials)

```
git clone https://github.com/Gate-Test/Crontech.git /tmp/crontech
cd /tmp/crontech
node /home/user/GateTest/bin/gatetest.js --suite quick
# expect: BLOCKED gate, ~750+ errors, ~25s wall time
```

For the Nuclear pipeline:
```
ANTHROPIC_API_KEY=... node <script that imports diagnoseFindings,
   correlateFindings, composeExecutiveSummary and feeds them the
   findings list>
# expect: 10/10 diagnoses, 2-3 critical chains, headline produced
```
