# Day-3 Proof — Surgical-Fix Byte-Equality

**Date:** 2026-05-12
**Branch:** `claude/fix-scan-timeout-issues-UJWLi`
**Status:** Architectural guarantee verified by 38 unit tests + 1 end-to-end CLI test.

---

## What was promised

Day-2 introduced surgical-diff mode in the website route. Day-3 ported it
into the CLI engine so the protected-platform gate workflow (Crontech,
Gluecron) also benefits.

The promise to customers:

> Bytes outside the issue's line range are byte-identical to the original.
> The auto-fixer never reformats, renames, or "improves" unrelated code.

This proof documents the verification that holds the promise.

---

## How the guarantee is structured

The surgical-fix module (`website/app/lib/surgical-fix.js`) has five pure
functions and one architectural invariant:

```
                    ┌───────────────────────────────────────┐
                    │  extractIssueContext(content, lineNo) │
                    │  → { slice, startLine, endLine,       │
                    │      lineEnding, totalLines }         │
                    └──────────────┬────────────────────────┘
                                   ▼
                    ┌───────────────────────────────────────┐
                    │  buildSurgicalPrompt({ slice, ... })  │
                    │  Claude sees ONLY this slice.         │
                    └──────────────┬────────────────────────┘
                                   ▼
                    ┌───────────────────────────────────────┐
                    │  Claude returns replacement block     │
                    │  parseReplacementBlock(raw) → string  │
                    └──────────────┬────────────────────────┘
                                   ▼
                    ┌───────────────────────────────────────┐
                    │  spliceReplacement(original,          │
                    │      startLine, endLine, replacement) │
                    │  Output =                             │
                    │    [original 0..startLine-2]          │
                    │  + [replacement]                      │
                    │  + [original endLine..end]            │
                    └──────────────┬────────────────────────┘
                                   ▼
                    ┌───────────────────────────────────────┐
                    │  validateSurgicalFix(original,        │
                    │      fixed, startLine, endLine)       │
                    │  Asserts before/after sections are    │
                    │  byte-identical. Defense-in-depth.    │
                    └───────────────────────────────────────┘
```

The byte-equality guarantee is **structural**, not heuristic:

- `spliceReplacement` is a pure function that takes the original content
  and only replaces the lines in `[startLine..endLine]`.
- The lines outside that range are passed through by array slice +
  rejoin with the detected line ending. They cannot be modified.
- `validateSurgicalFix` re-verifies this independently. It catches any
  case where a caller might construct `fixedContent` outside the natural
  `spliceReplacement` flow.

---

## Evidence — 38 unit tests across 4 modules

```
$ node --test tests/surgical-fix.test.js \
              tests/whole-file-mutation-guard.test.js \
              tests/ai-fix-engine-surgical.test.js
```

| Test file | Tests | Pass | What it proves |
| --- | --- | --- | --- |
| `tests/surgical-fix.test.js` | 10 | 10 | Slicer clamps top/bottom, detects CRLF, splice preserves before+after sections byte-identical, validator catches outside-window mutation, validator accepts clean splice. |
| `tests/whole-file-mutation-guard.test.js` | 22 | 22 | Diff counts byte-identical / single-line / insert / delete / whole-file-rewrite. Evaluator accepts 1-issue/3-line fix, rejects 50% file rewrite, rejects per-issue × 8 budget overflow. |
| `tests/ai-fix-engine-surgical.test.js` | 6 | 6 | CLI engine routes line-numbered issues to surgical mode, rejects empty replacements, runs whole-file fallback through mutation guard, preserves existing no-key / too-large early returns. |
| **Total** | **38** | **38** | |

**Sweep checklist (this branch):**

```
$ node --test tests/*.test.js
# tests 1602
# pass 1588
# fail 14   (← 14 pre-existing MCP cold-spawn subprocess timeouts,
              commit d3e9a72 already attempted deflake; outside Day-3 scope)
```

---

## Worked example — fixing a single line in a real file

Consider `src/core/ai-fix-engine.js` (the CLI engine itself, 391 lines after
Day-3 port). Suppose a future scan flags line 138:

```
src/core/ai-fix-engine.js:138 — console.log left in library code
```

The CLI's `aiFix({ filePath, issueMessage, lineNumber: 138 })` runs:

1. **extractIssueContext** with `contextLines=20` →
   `{ startLine: 118, endLine: 158, slice: <41 lines>, lineEnding: '\n' }`

2. **buildSurgicalPrompt** sends Claude exactly those 41 lines, numbered.
   Lines 1-117 and 159-391 are **never sent**. They cannot influence the
   prompt, the model's attention, the response, or the eventual file.

3. Claude returns a replacement block — say it removes the console.log on
   line 138 (line 21 of the slice).

4. **parseReplacementBlock** strips fences and line-number prefixes.

5. **spliceReplacement** produces a new file:
   - `original_lines[0..116]` ← byte-identical
   - replacement block (41 lines)
   - `original_lines[158..390]` ← byte-identical

6. **validateSurgicalFix** asserts the byte-equality of (1) and (3)
   independently. If the model somehow returned a payload that, after the
   splice, mutated line 50 or line 300, the validator's structural check
   would catch it and `aiFix` returns
   `{ fixed: false, description: "mutated outside slice (rejected by validator)" }`.

Customer sees: **a PR that touches exactly the lines around the issue**,
nothing else. No reformat. No rename. No "improvement."

---

## Worked example — rejecting a whole-file rewrite (fallback path)

When an issue has **no line number** (summary-shaped findings like "X tests
failed", `CREATE_FILE` cases), the engine falls back to the existing
whole-file Claude flow. Day-3 wraps that path with
`whole-file-mutation-guard.evaluateMutation`:

Defaults: `maxChangePerIssue = 8`, `maxAbsoluteChange = 80`,
`maxPercentChange = 0.30`.

Real-shape example — a 200-line file, one issue:

| Scenario | totalChangedLines | Rule that fires | Result |
| --- | ---: | --- | --- |
| Targeted 3-line fix | 6 | (none — within budget) | **accepted** |
| Single function refactor, 25 lines | 50 | (none — within budget) | **accepted** |
| Two-function shuffle, 70 lines | 140 | percent (140/200 = 70% > 30%) | **rejected: file-rewrite** |
| Whole-file reformat, all 200 lines | 400 | percent (200%) | **rejected: file-rewrite** |
| 1-issue, 100-line refactor in 500-line file | 200 | per-issue (200 > 8 × 1 AND > 80) | **rejected: budget** |

The rules are deliberately permissive — real fixes pass, vandalism is
caught. The whole-file path is the **fallback**; surgical mode handles
the common case structurally.

---

## End-to-end CLI sanity

```
$ node bin/gatetest.js --version
GateTest v1.0.0

$ node bin/gatetest.js --list | grep -c "^  [a-z]"
90
```

90/90 modules load with Day-3 changes in place. CLI binary executes.

---

## Remaining gaps (honest)

This proof does **not** include a real Anthropic API call against a
customer repo. Doing so requires:

- Craig's `ANTHROPIC_API_KEY` set in the environment running the proof
- A target repo to scan + fix

That step belongs to Craig's first production validation run, ideally
on a small Gluecron-hosted repo with the secret set at the org level
(see `integrations/README.md` → "Turn ON auto-fix"). The architectural
guarantees in this document hold independently of that final run — the
splice math doesn't change based on which Claude model returns the
replacement.

---

## Sign-off

Surgical mode is byte-equality-safe by construction, defended by an
independent validator, and exercised by 38 unit tests across the slicer,
guard, and CLI engine. Whole-file fallback is now wrapped by a tunable
mutation guard. The protected-platform gate workflow's auto-repair step
inherits both guarantees the moment `ANTHROPIC_API_KEY` is set as an
organization secret.

— Day-3, `claude/fix-scan-timeout-issues-UJWLi`
