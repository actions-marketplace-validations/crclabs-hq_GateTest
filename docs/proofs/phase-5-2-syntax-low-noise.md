# Phase 5.2.5c — Integrity-check proof: low-noise `syntax` module

**Status:** STUB — pending session with enough scans to confirm
`syntax` accumulates ≤ 3 dissent events per 30-day window across the
entire customer base.
**Target module:** `syntax`.
**Why this module:** Syntax errors are objective. Real syntax errors
are real; false positives are extremely rare. Confidence scoring
should leave this module alone — score should remain ≥ 0.9 → action
= `trust`. If the scorer suppresses or downgrades `syntax`, the
scoring math is broken.

## How to fill this in

After 30 days of scans:

1. Confirm low dissent volume:
   ```sql
   SELECT module, COUNT(*) AS n
   FROM dissent
   WHERE created_at > NOW() - INTERVAL '30 days'
     AND module = 'syntax'
   GROUP BY module;
   ```
   Expected: n ≤ 3 (very low).
2. Trigger refresh:
   ```bash
   curl -X POST https://gatetest.ai/api/admin/learning/refresh
   ```
3. Confirm score is in `trust` band:
   ```sql
   SELECT score FROM module_confidence
   WHERE module = 'syntax';
   ```
   Expected: score ≥ 0.9.
4. Run a scan with a real syntax error and confirm it surfaces as
   `error` (not downgraded).

## Sections to fill

### Dissent count (30d)

```
(SELECT COUNT output — should be very small)
```

### Confidence score

```
(should be ≥ 0.9, action 'trust')
```

### Real syntax error rendered as error

```
(paste a finding from a real scan — should still say 'error: ...'
in the output, NOT 'warning: ...')
```

### Honest assessment

`(paragraph — confirm or deny: the scorer left a low-noise module
alone. If the score dropped below 0.85 despite low dissent, the
scoring math has a bug — fix it before relying on the system.)`

---

_Generated as part of Phase 5.2.5 of THE 110% MANDATE — gatetest.ai_
