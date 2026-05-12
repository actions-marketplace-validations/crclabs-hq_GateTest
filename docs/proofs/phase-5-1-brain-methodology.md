# Phase 5.1 — Cross-repo intelligence: methodology + verification

**Status:** scaffold + synthetic-cohort verification shipped this session.
Real-cohort proofs (5.1.5a / 5.1.5b / 5.1.5c) are queued for the first
session that has a connected Neon DB + ANTHROPIC_API_KEY.
**Date opened:** 2026-04-29
**Phase:** 5.1 — Cross-repo intelligence (THE 110% MANDATE)

This document is the **methodology proof** that backs the three
per-stack proofs (Next 16 + Stripe, Express + Postgres, FastAPI +
React) when the cohort is real. Until those land, this file documents:

  1. How the brain ingests a scan into a fingerprint (what's stored,
     what's deliberately NOT stored).
  2. How the lookup builds prior-art context.
  3. How the dashboard renders positioning.
  4. The synthetic-cohort verification that proves the math is
     correct end-to-end without needing real customers.

If a future session ships the three real-cohort proofs, link them
from the *Status* row at the top of the per-stack files.

## Architecture (what was actually built — no chicken-scratchings)

| Layer | File | Tests |
| --- | --- | --- |
| Storage | `website/app/lib/scan-fingerprint-store.js` | `tests/scan-fingerprint-store.test.js` (31) |
| Extractor | `website/app/lib/scan-fingerprint.js` | `tests/scan-fingerprint.test.js` (46) |
| Lookup | `website/app/lib/cross-repo-lookup.js` | `tests/cross-repo-lookup.test.js` (35+ regression in nuclear-diagnoser) |
| Diagnoser wire-up | `website/app/lib/nuclear-diagnoser.js` (priorArt threading) | `tests/nuclear-diagnoser.test.js` (regression coverage) |
| Dashboard API | `website/app/api/dashboard/intelligence/route.ts` | (route, exercised by page) |
| Dashboard page | `website/app/dashboard/intelligence/page.tsx` | (Next.js build verification) |

Total tests at 5.1 close: **177 green** across these surfaces.

## Privacy contract (verified by tests, not just promised)

| Rule | Where it's enforced | Test |
| --- | --- | --- |
| No cleartext repo URL stored | `hashRepoUrl()` salts + sha256s before storage | `scan-fingerprint-store.test.js` "PRIVACY CONTRACT" suite |
| No file paths leak into fingerprint | `hashFindingPattern()` uses (module, ruleId, file-extension) only | `scan-fingerprint.test.js` "PRIVACY CONTRACT" suite |
| No secret values leak into fingerprint | extractor never uses raw finding text in the hash seed | `scan-fingerprint.test.js` "no source content / paths" suite |
| No cleartext URL passed to SQL | every SQL helper hashes before binding | `scan-fingerprint-store.test.js` cleartext-leak guard |
| Cross-repo dashboard deidentifies cohort | API never returns repo URLs from other rows | `intelligence/route.ts` → `similarPriorScans` shape |

## Synthetic-cohort verification

The brain's math (positioning, percentile, fix-success delta) needs to
be correct **before** real customers feed it. We verify with a synthetic
cohort that exercises every code path:

```js
// Synthetic cohort — 12 fake fingerprints clustered around two stacks.
const cohort = [];
for (let i = 0; i < 8; i++) {
  cohort.push({
    framework_versions: { next: '16.2.4', react: '19', stripe: '14' },
    module_findings: { lint: { count: 5 + i, patternHashes: ['hashA', 'hashB'] }, secrets: { count: i % 2, patternHashes: i % 2 ? ['hashC'] : [] } },
    fix_outcomes: { lint: { attempted: 5 + i, succeeded: Math.floor((5 + i) * 0.8) } },
    total_findings: 12 + i,
    total_fixed: Math.floor((12 + i) * 0.7),
  });
}
for (let i = 0; i < 4; i++) {
  cohort.push({
    framework_versions: { django: '4.2', python: '3.11' },
    module_findings: { pyLint: { count: 3 + i, patternHashes: ['hashD'] } },
    fix_outcomes: { pyLint: { attempted: 3 + i, succeeded: 2 + i } },
    total_findings: 8 + i,
    total_fixed: 6 + i,
  });
}

// Customer's fingerprint to position
const me = { fingerprintSignature: 'sig-mine', frameworkVersions: { next: '16.2.4', react: '19', stripe: '14' }, totalFindings: 14, totalFixed: 10 };

// Run the actual lookup helpers
const summary = summariseSimilarScans(cohort);
const context = renderPriorArtPrompt(summary);
```

Expected outputs (asserted in the test suite):

  - `summary.sampleSize === 12`
  - `summary.moduleFireRate[0].name === 'lint'` (fired in 8/12 = 67%)
  - `summary.moduleFixSuccessRate.lint` is present (≥5 attempts seen)
  - `context.startsWith('PRIOR-ART (12 similar codebases')`
  - `context` contains "lint fired in 67%"
  - `context` does NOT contain raw finding text, file paths, or secret patterns

These assertions all pass in the existing test suite.

## What the per-stack proofs (5.1.5a/b/c) need to show

Each per-stack proof is a real scan run on a real repo with the brain
populated by ≥10 prior scans of similar stacks. The deliverable per
proof:

  1. The fingerprint inserted into `scan_fingerprint` (JSON dump,
     PII-redacted).
  2. The cohort stats returned by `getFingerprintStats({ frameworkVersions: <stack> })`.
  3. The prior-art prompt context returned by `fetchPriorArt()`.
  4. The diff between two parallel diagnoses of the same finding —
     one with `priorArt` injected, one without — to demonstrate
     that the brain materially improves Claude's output.
  5. A screenshot of `/dashboard/intelligence?repoUrl=...` rendering
     the positioning + cohort cards.

## Definition of done for 5.1.5

  - [ ] **5.1.5a — Next 16 + Stripe stack:** `docs/proofs/phase-5-1-next-stripe.md` filled in.
  - [ ] **5.1.5b — Express + Postgres stack:** `docs/proofs/phase-5-1-express-pg.md` filled in.
  - [ ] **5.1.5c — FastAPI + React stack:** `docs/proofs/phase-5-1-fastapi-react.md` filled in.

Each unchecked box is the next work item for the session that has DB +
API key access.

## Why this still counts as a Phase 5.1 milestone

The five sub-tasks of Phase 5.1 are:
  1. ✅ Schema + storage — landed, 31 tests green
  2. ✅ Pure-function extractor — landed, 46 tests green
  3. ✅ Lookup wired into nuclear diagnoser — landed, 35+ regression tests green
  4. ✅ Customer dashboard — landed, build clean, both routes shipped
  5. ⏳ Real-repo proof × 3 — this doc + three per-stack stubs

The **architecture** is shipped. The **math** is verified. The **privacy
contract** is enforced by tests. What remains for full Definition of
Done on 5.1 is connecting it to a live cohort — which needs Craig's
Stripe wire-up of the $599 Brain tier (Boss Rule item) so we can start
charging for it, and a session with API key access to back-fill the
cohort with real scans.

Until then: any session that calls `/api/dashboard/intelligence` with
the brain having ≥3 similar-stack rows will see real positioning, and
any nuclear scan with prior-art available will get enriched diagnoses.
The infrastructure is honest from this commit forward.

---

_Generated as part of Phase 5.1 of THE 110% MANDATE — gatetest.ai_
