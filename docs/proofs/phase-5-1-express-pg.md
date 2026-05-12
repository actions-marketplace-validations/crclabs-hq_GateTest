# Phase 5.1.5b — Real-repo proof: Express + Postgres stack

**Status:** STUB — pending session with DB + ANTHROPIC_API_KEY access.
**Target stack:** Node Express 4.x + Postgres (node-pg or Sequelize).
**Candidate repos:** any active Express+pg codebase from the cohort
(Crontech's worker tier is one candidate; an external open-source
pick like `expressjs/express` is another).
**Prerequisite cohort:** ≥10 prior scans of distinct Express + Postgres
repos populated into `scan_fingerprint`.

## Why this stack matters for the brain

Express + Postgres is the canonical "Node SaaS backend" shape — one of
the highest-volume stacks GateTest will see. The brain should reach
maximum maturity on this stack first. Findings the brain should
reliably surface across the cohort:

  - N+1 Sequelize / node-pg query patterns
  - Missing indexes on foreign-key columns
  - Express middleware ordering bugs (auth after CORS, etc.)
  - Express rate-limiter mis-configurations
  - SQL-injection-shape patterns in raw `query` calls
  - Missing parameterised inserts in transaction blocks

If the brain DOESN'T see these as common patterns across the cohort,
the brain isn't working — that's a strong falsifiable claim and the
proof must be honest about it.

## How to fill this in

Same procedure as 5.1.5a (Next + Stripe). See
`phase-5-1-next-stripe.md` for the SQL queries + capture sections.

## Sections to fill

### Fingerprint inserted

```
(paste fingerprint JSON here, PII redacted)
```

### Cohort stats

```
(paste cohort stats here)
```

### Diagnosis comparison

```
WITHOUT prior-art:
  ...

WITH prior-art:
  ...

DELTA: ...
```

### Dashboard screenshot

`(attach)`

### Honest assessment

`(one paragraph)`

---

_Generated as part of Phase 5.1.5 of THE 110% MANDATE — gatetest.ai_
