# Phase 5.2 — Closed feedback loop: methodology + verification

**Status:** infrastructure shipped. Real-cohort proofs queued for the
session that has accumulated ≥100 dissent events on real customer
scans.
**Date opened:** 2026-04-29
**Phase:** 5.2 — Closed feedback loop (THE 110% MANDATE)

This document is the **methodology proof** that backs the per-module
proofs (5.2.5a / 5.2.5b / 5.2.5c) when real dissent has accumulated.
Until those land, this file documents:

  1. The full architecture: dissent capture → FP scorer → confidence-
     aware reporting → operator dashboard.
  2. The privacy contract enforced by tests.
  3. How to fill the per-module proofs when real data arrives.

## Architecture (what was actually built — no chicken-scratchings)

| Layer | File | Tests |
| --- | --- | --- |
| Storage (5.2.1 back) | `website/app/lib/dissent-store.js` | `tests/dissent-store.test.js` (27) |
| API (5.2.1 front) | `website/app/api/dissent/route.ts` | (route, exercised by FindingsPanel) |
| UI (5.2.1) | `website/app/components/FindingsPanel.tsx` thumbs-down | (TSX build verification) |
| Rollback hook (5.2.1) | `website/app/api/scan/fix/route.ts` scanner-gate dissent | (route, integration) |
| FP scorer (5.2.2) | `website/app/lib/module-confidence.js` | `tests/module-confidence.test.js` (26) |
| Manual refresh (5.2.2) | `website/app/api/admin/learning/refresh/route.ts` | (route) |
| Cron (5.2.2) | `website/app/api/admin/learning/cron/route.ts` + `vercel.json` | (cron schedule '0 6 * * 1') |
| Reporting (5.2.3) | `website/app/lib/confidence-aware-report.js` | `tests/confidence-aware-report.test.js` (21) |
| /api/scan/run wiring (5.2.3) | `website/app/api/scan/run/route.ts` | (build verification) |
| Operator API (5.2.4) | `website/app/api/admin/learning/route.ts` | (route) |
| Operator dashboard (5.2.4) | `website/app/admin/learning/page.tsx` | (TSX build verification) |

Total tests at 5.2 close: **74 new** (27 + 26 + 21) on top of the
117 from 5.1, for 191 across the brain + feedback loop.

## End-to-end flow

```
Customer clicks "false positive" (FindingsPanel)
   → POST /api/dissent { kind: "false_positive", module, repoUrl }
   → dissent-store.recordDissent (hashes URL + reviewer, caps notes)
   → INSERT INTO dissent

Customer's auto-fix gets rolled back (cross-file scanner gate)
   → /api/scan/fix records FIX_REJECTED dissent for each rolled-back fix
   → INSERT INTO dissent

Weekly cron at "0 6 * * 1"
   → GET /api/admin/learning/cron (Vercel-cron auth)
   → moduleConfidence.refreshModuleConfidence
     → aggregateDissentByModulePattern (last 30d)
     → for each (module, pattern_hash):
         compute confidence score (pure function, deterministic)
         UPSERT INTO module_confidence

Customer's next scan runs
   → /api/scan/run completes the modules
   → for each module: getConfidenceScore (cached per (module, pattern_hash))
   → confidence-aware-report.applyConfidenceToScan
     trust       (score ≥ 0.85) → pass through
     downgrade   (score ≥ 0.65) → error → warning, warning → info
     double-down (score ≥ 0.45) → all → info
     suppress    (score < 0.45) → drop the finding
   → Response includes confidenceAdjustments:{suppressed,downgraded}
   → FindingsPanel renders adjusted severities

Operator opens /admin/learning
   → GET /api/admin/learning
   → sees: modules tracked, lowest score, dissent kinds breakdown,
     50 worst-scored modules, 50 most recent dissent events
   → can manually trigger refresh after a wave of dissent
```

## Privacy contract (verified by tests)

| Rule | Where it's enforced | Test |
| --- | --- | --- |
| Cleartext repo URL never reaches SQL values | `recordDissent`, `listDissentForRepo` | `dissent-store.test.js` PRIVACY CONTRACT suite |
| Cleartext reviewer identity never reaches SQL | `hashReviewer` runs before binding | `dissent-store.test.js` PRIVACY CONTRACT suite |
| Reviewer hash is case-insensitive | `hashReviewer('Craig') === hashReviewer('craig')` | `dissent-store.test.js` |
| Notes free-text capped at 500 chars | `recordDissent` slices to 500 | `dissent-store.test.js` |
| DISSENT_KINDS enum locked | `Object.freeze` + `isFrozen` test | `dissent-store.test.js` |
| Confidence scoring is deterministic | Pure function, same input → same output | `module-confidence.test.js` |
| Brain unavailable never blocks customers | `applyConfidenceToScan` falls through on error | `/api/scan/run` try/catch |

## Scoring math — falsifiable claims the test suite verifies

  - **Trust default**: zero dissent + zero findings → score 1.0 (no
    suppression of brand-new modules with no track record).
  - **Concentrated noise gets less weight**: 80 dissent rows from 1
    customer score HIGHER than 80 dissent rows from 80 distinct
    customers (the spread factor).
  - **Tiny samples get lifted**: 1 dissent + 1 finding scores higher
    than 50 dissent + 50 findings at the same ratio (volume floor).
  - **Fix-success rebalances**: high auto-fix success on a
    high-dissent pattern earns ~5% lift back (the dissent might be
    about the FIX shape, not the finding's correctness).
  - **Score clamps to [0, 1]**: adversarial inputs (negative
    findings, overflow fix-success) never produce out-of-range
    scores.

## What the per-module proofs (5.2.5a/b/c) need to show

Each per-module proof is a real before/after measurement on a
specific module that's been receiving dissent. The deliverable per
proof:

  1. SELECT from `dissent` showing ≥30 events for the (module,
     pattern_hash) pair.
  2. The computed `module_confidence.score` after a refresh run.
  3. Sample finding output BEFORE the confidence layer applied
     (raw severity).
  4. Sample finding output AFTER the confidence layer applied
     (downgraded / suppressed).
  5. Customer-facing FP-rate metric: (# findings reported /
     # findings shown after confidence) over a 7-day window — should
     trend down over time.

## Definition of done for 5.2.5

  - [ ] **5.2.5a:** A high-noise module (likely candidate: `lint` on
        TypeScript-only repos where some rules are noisier than others).
  - [ ] **5.2.5b:** A medium-noise module (likely: `secrets` —
        env-shape false positives in dotfiles).
  - [ ] **5.2.5c:** A low-noise module that should remain untouched
        (likely: `syntax` — almost never has FPs).

The third proof is the integrity check: confidence-aware reporting
shouldn't quietly suppress a module that's working fine.

## Why this still counts as a Phase 5.2 milestone

The five sub-tasks of Phase 5.2 are:
  1. ✅ Dissent capture (storage + UI hooks) — landed, 27 tests + UI shipped
  2. ✅ Per-module FP scorer + cron — landed, 26 tests + cron schedule added
  3. ✅ Confidence-aware reporting — landed, 21 tests + /api/scan/run wired
  4. ✅ Operator dashboard — landed, /admin/learning shipped
  5. ⏳ Real-customer proof × 3 — this doc + three per-module stubs

The **architecture** is shipped end-to-end. The **math** is verified.
The **privacy contract** is enforced by tests. What remains is
accumulating real customer dissent — which depends on customer volume,
not engineering.

Until then: any session that triggers `/api/admin/learning/refresh` on
a populated `dissent` table will see real per-(module, pattern) scores,
and any customer scan after that will get adjusted severities.

---

_Generated as part of Phase 5.2 of THE 110% MANDATE — gatetest.ai_
