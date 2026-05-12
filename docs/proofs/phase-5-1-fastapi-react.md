# Phase 5.1.5c — Real-repo proof: FastAPI + React stack

**Status:** STUB — pending session with DB + ANTHROPIC_API_KEY access.
**Target stack:** Python FastAPI 0.110+ backend + React 18/19 frontend
(separate repos or monorepo).
**Candidate repos:** an active FastAPI+React codebase from the cohort.
**Prerequisite cohort:** ≥10 prior scans of distinct FastAPI + React
codebases populated into `scan_fingerprint`.

## Why this stack matters for the brain

FastAPI + React is the canonical modern Python+JS polyglot. It tests
two cross-cutting brain capabilities at once:

  1. The fingerprint extractor must correctly identify both stacks
     (Python `pyproject.toml` / `requirements.txt` AND
     `package.json`) on a single repo.
  2. The cross-language unified-semantics work in Phase 5.5 will
     extend the brain across the FastAPI ↔ React contract boundary
     (OpenAPI spec drift). 5.1.5c is the foundational fingerprint
     scan that 5.5 builds on top of.

Findings the brain should reliably surface across the cohort:

  - Naive `datetime.now()` (Python) without `tz=utc`
  - `verify=False` in Python `requests.get` (TLS bypass)
  - `parseFloat` on money-named React state
  - Mixed-string/number prop types across the component tree
  - Missing `httponly` on cookie set in FastAPI response
  - Async-iteration footguns (`.reduce(async ...)`) on the React side

## How to fill this in

Same procedure as 5.1.5a. See `phase-5-1-next-stripe.md` for the
SQL queries + capture sections.

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

`(one paragraph — be especially honest about whether the brain helps
on a polyglot codebase, since the storage-layer fingerprint signature
includes BOTH stacks' framework versions in the same hash. If the
cohort is too small for polyglot stacks specifically, say so.)`

---

_Generated as part of Phase 5.1.5 of THE 110% MANDATE — gatetest.ai_
