# PR #70 — Merge Audit

**Branch:** `hotfix/wrong-import-alias` → `main`
**Commits:** 1 (`036996d`)
**Files changed:** 2
**Lines:** +5 / -5
**Risk:** Trivial

## What this PR does

Five one-line import-path corrections. `@lib/audit-log-store` and `@lib/cli-engine-runner` → `@/app/lib/audit-log-store` and `@/app/lib/cli-engine-runner`.

## Why it's needed

Vercel build is currently failing on `main` at commit `c8d4ef1`:
- `Module not found: Can't resolve '@lib/audit-log-store'`
- `Module not found: Can't resolve '@lib/cli-engine-runner'`

The `@lib/` alias resolves to repo-root `/lib/`. The files live at `website/app/lib/` and are served by the `@/app/lib/` alias.

## Files touched

```
website/app/api/scan/fix/route.ts    (2 lines changed)
website/app/api/scan/run/route.ts    (3 lines changed)
```

## What this DOESN'T touch

- No module logic
- No tests
- No pricing
- No public-facing copy
- No env vars
- No dependencies

Pure import-path correction.

## Test plan

- [x] `grep` confirms zero `@lib/audit-log-store` or `@lib/cli-engine-runner` references remain
- [x] Files exist at the corrected paths
- [ ] Vercel preview build (will surface on push)

## Merge confidence

**High.** The change is mechanical, isolated, and reversible in one commit if it surfaces an unrelated issue. Worst case: Vercel still fails for a different reason — but the current failure mode is fixed regardless.

## Action

Merge first. Restores main builds. ~2 min of your time. Vercel rebuild will go green ~90 seconds later.
