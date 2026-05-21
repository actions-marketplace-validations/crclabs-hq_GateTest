# Flywheel training corpus

This directory holds the seed corpus used to train (and measure) the GateTest flywheel layers.

## Why

The flywheel has three deterministic layers — AST, Rule, Recipe — that run BEFORE Claude on every fix. Every time one of them produces the correct fix, we save the Anthropic spend on that finding. Over time, as we add rules + recipes, the **Claude-call ratio** drops, and per-fix cost trends to zero. That's the moat.

To measure progress we need a fixed corpus of (broken → fixed) instances we replay every night, recording which layer handled each one. The ratio over time is the metric on the admin dashboard.

## Format

`instances.json` is an envelope object:

```json
{
  "version": 1,
  "instances": [
    {
      "id": "stable-string-id",
      "language": "javascript" | "typescript" | "python" | "yaml" | ...,
      "file": "src/relative/path.js",
      "issues": ["rule-key:sub-rule:file:line", ...],
      "broken": "the broken file content as a string",
      "fixed": "the known-good fixed file content as a string",
      "note": "human-readable explanation of the bug class"
    }
  ]
}
```

The `issues` array is what the rule + AST layers' `matches(issueStr)` predicates see. Format matches what GateTest's scanners emit, so a rule that fires against real customer findings will also fire against the corpus.

## Running the harness

```bash
node scripts/train-flywheel.js --corpus corpus/seed/instances.json
```

This will:
1. Load every instance.
2. Try the AST layer, then the Rule layer, then the Recipe layer (if available).
3. Record telemetry to `~/.gatetest/telemetry/fix-attempts.jsonl`.
4. Print a summary: total / handled-by-layer / would-fall-through-to-Claude.

Add `--strict` to fail the run if the Claude-call ratio rises vs. the previous run (regression guard).

## Sources to add over time

- **SWE-bench Verified** (500 real GitHub issue+fix pairs) — public dataset.
- **SWE-bench full** (2,294 instances) — broader, harder cases.
- **Public-OSS CI failure miner** (`scripts/mine-public-failures.js`, planned) — scrapes failed CI runs + their fix commits from popular repos.
- **Mutation testing on protected platforms** — `src/modules/mutation.js` already mutates source; each mutation is a synthetic failure with a known fix.
- **Our own historical commits** — every commit-pair where tests went red→green is training data.

## Adding instances

Hand-curated additions are welcome. Each should be:
- **Hermetic** — file content alone is enough to reproduce the bug class.
- **Realistic** — the broken form must match real-world code shape.
- **Verifiable** — the fixed form must actually fix the broken form (no partial fixes).
- **Small** — full file content < 1KB unless absolutely necessary.

CI does NOT block on new corpus instances; they're additive.
