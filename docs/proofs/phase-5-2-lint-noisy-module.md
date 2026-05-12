# Phase 5.2.5a — Real-cohort proof: noisy `lint` module

**Status:** STUB — pending session with ≥30 dissent events recorded
on the `lint` module in production.
**Target module:** `lint`.
**Why this module:** ESLint-derived patterns are the textbook noisy
case — false positives are common when a project uses idioms ESLint
defaults don't recognise. Strong candidate for the brain to
downgrade automatically per-customer.

## How to fill this in

After dissent has accumulated:

1. Confirm enough data:
   ```sql
   SELECT module, pattern_hash, COUNT(*) AS n,
          COUNT(DISTINCT repo_url_hash) AS distinct_repos,
          COUNT(DISTINCT reviewer_hash) AS distinct_reviewers
   FROM dissent
   WHERE module = 'lint'
     AND created_at > NOW() - INTERVAL '30 days'
   GROUP BY module, pattern_hash
   HAVING COUNT(*) >= 30
   ORDER BY n DESC;
   ```
2. Trigger a refresh:
   ```bash
   curl -X POST https://gatetest.ai/api/admin/learning/refresh \
        -H "Cookie: gatetest_admin_session=..."
   ```
3. Check the resulting confidence score:
   ```sql
   SELECT * FROM module_confidence
   WHERE module = 'lint'
   ORDER BY score ASC LIMIT 5;
   ```
4. Run a scan against the same kind of repo and capture:
   - The raw `runTier` modules output (severity unmodified).
   - The `/api/scan/run` response (severities adjusted).
   - The `confidenceAdjustments` field from the response.
5. Track the FP rate over the next 7 days:
   ```sql
   SELECT
     COUNT(*) FILTER (WHERE kind = 'false_positive') AS new_fp,
     COUNT(*) FILTER (WHERE kind = 'rolled_back') AS new_rollbacks
   FROM dissent
   WHERE module = 'lint'
     AND created_at > NOW() - INTERVAL '7 days';
   ```

## Sections to fill

### Aggregated dissent (snapshot)

```
(paste the SQL output from step 1)
```

### Computed confidence score

```
(paste step 3 output — score, dissent_count, distinct_repos, action)
```

### Before / after sample

```
BEFORE confidence layer:
  - error: src/foo.ts:1 — uses var declaration
  - error: src/foo.ts:3 — uses var declaration
  - error: src/foo.ts:5 — uses var declaration

AFTER confidence layer (action = downgrade):
  - warning: src/foo.ts:1 — uses var declaration
  - warning: src/foo.ts:3 — uses var declaration
  - warning: src/foo.ts:5 — uses var declaration

confidenceAdjustments: { suppressed: 0, downgraded: 3 }
```

### 7-day FP-rate trend

```
(table of week-over-week FP rate; should trend down)
```

### Honest assessment

`(one paragraph: did the brain materially reduce noise without
suppressing real bugs? If a real bug got suppressed, the brain
needs tuning — be honest about it. Phase 4 honesty sweep applies.)`

---

_Generated as part of Phase 5.2.5 of THE 110% MANDATE — gatetest.ai_
