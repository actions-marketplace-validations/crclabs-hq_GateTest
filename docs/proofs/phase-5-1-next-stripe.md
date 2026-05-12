# Phase 5.1.5a — Real-repo proof: Next 16 + Stripe stack

**Status:** STUB — pending session with DB + ANTHROPIC_API_KEY access.
**Target stack:** Next.js 16.x + React 19 + Stripe 14.x.
**Candidate repo:** `ccantynz-alt/gatetest` (this repo) — itself a
production Next 16 + Stripe codebase.
**Prerequisite cohort:** ≥10 prior scans of distinct Next 16 + Stripe
repos populated into `scan_fingerprint`.

## How to fill this in

1. Run a Nuclear-tier scan against the candidate repo:
   ```bash
   curl -X POST https://gatetest.ai/api/scan/nuclear \
     -H "Content-Type: application/json" \
     -d '{"repoUrl": "https://github.com/ccantynz-alt/gatetest", "tier": "nuclear"}'
   ```
2. Capture the fingerprint inserted into `scan_fingerprint`:
   ```sql
   SELECT id, framework_versions, language_mix, total_findings, total_fixed,
          fingerprint_signature, created_at
   FROM scan_fingerprint
   WHERE repo_url_hash = (
     SELECT repo_url_hash FROM scan_fingerprint
     WHERE created_at > NOW() - INTERVAL '5 minutes'
     ORDER BY created_at DESC LIMIT 1
   )
   ORDER BY created_at DESC LIMIT 1;
   ```
3. Capture the cohort stats:
   ```sql
   SELECT COUNT(*),
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_findings),
          PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_findings)
   FROM scan_fingerprint
   WHERE framework_versions @> '{"next":"16.2"}'::jsonb
     AND created_at > NOW() - INTERVAL '30 days';
   ```
4. Run two parallel diagnoses of one HIGH-severity finding — one
   with `priorArt`, one without. Paste both into this doc.
5. Screenshot `/dashboard/intelligence?repoUrl=...` showing the
   positioning + cohort cards.

## Sections to fill

### Fingerprint inserted

```
(paste fingerprint JSON here, PII redacted — keep framework_versions,
language_mix, total_findings, fix_outcomes; redact repo_url_hash)
```

### Cohort stats

```
(paste cohort stats here — sampleSize, medianFindings, p90Findings,
fixSuccessRate)
```

### Diagnosis comparison

```
WITHOUT prior-art:
  EXPLANATION: ...
  ROOT_CAUSE: ...
  RECOMMENDATION: ...

WITH prior-art:
  EXPLANATION: ...
  ROOT_CAUSE: ...
  RECOMMENDATION: ...

DELTA: <one paragraph describing what the brain added>
```

### Dashboard screenshot

`(attach screenshot showing the positioning card, cohort stats, and
module fire-rate bars)`

### Honest assessment

`(one paragraph: did the brain materially improve the diagnosis?
If not, why not? Don't fake the answer — Phase 4 honesty sweep
applies retroactively.)`

---

_Generated as part of Phase 5.1.5 of THE 110% MANDATE — gatetest.ai_
