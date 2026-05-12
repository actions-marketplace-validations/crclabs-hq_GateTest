# Phase 5.2.5b — Real-cohort proof: medium-noise `secrets` module

**Status:** STUB — pending session with ≥30 dissent events on the
`secrets` module.
**Target module:** `secrets`.
**Why this module:** Secret detection has classic medium-noise
patterns: env-shape strings in `.env.example` files, placeholder
values that match credential shapes, fixture data in test files.
Some are real signal; some are textbook FP. Confidence scoring is
the right tool to separate them.

## How to fill this in

Same procedure as 5.2.5a (lint), substituting `module = 'secrets'`.
See `phase-5-2-lint-noisy-module.md` for the SQL queries +
methodology.

## Sections to fill

### Aggregated dissent (snapshot)

```
(paste SQL output)
```

### Computed confidence score

```
(paste module_confidence row)
```

### Before / after sample

```
BEFORE:
  - error: .env.example:5 — hardcoded API key (DATABASE_URL=postgres://...)

AFTER (action = ?):
  - ?
```

### 7-day FP-rate trend

```
(week-over-week)
```

### Honest assessment

`(paragraph — emphasise that medium-noise modules are the hardest
test case for the scorer. If the brain over-suppresses real secrets
even once, that's a P0 bug; if it lets real placeholder noise
through, that's a P1 tuning issue. Be specific about which.)`

---

_Generated as part of Phase 5.2.5 of THE 110% MANDATE — gatetest.ai_
