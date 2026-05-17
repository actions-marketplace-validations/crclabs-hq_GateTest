# Proof: AI CI-fixer end-to-end run

**Date:** 2026-05-17
**Branch:** `ci/bulletproof-real-proof`
**Harness:** `scripts/proofs/run-ai-fixer-demo.sh`
**Run mode:** SYNTHETIC (neither `ANTHROPIC_API_KEY` nor `GITHUB_TOKEN` was set in this environment)

This document is a reproducible, honest proof that the AI CI-fixer
orchestrator closes the loop on a failing CI run: log → log parsing →
file read → Claude → parse patch → apply patch → run gate → commit →
push → open PR. The synthetic harness exercises the **real** code paths
of `scripts/ai-ci-fixer.js` + `lib/ai-ci-fixer-core.js` with the **only**
external surfaces stubbed (HTTPS transport, git runner, gate runner,
Claude callback).

In FULL mode the same `runFixer(deps)` entry point is invoked; only the
stubs are swapped for real HTTPS / real `spawnSync` / real Anthropic.
The contract surface is identical, which is why the synthetic harness
is a faithful proof of the production wiring.

---

## 1. Run mode

| Item                  | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | MISSING                                                        |
| `GITHUB_TOKEN`        | MISSING                                                        |
| Selected mode         | **SYNTHETIC**                                                  |
| Why                   | At least one of the two required env vars was unset            |
| Tooling exercised     | `scripts/ai-ci-fixer.js` and `lib/ai-ci-fixer-core.js` (real)  |
| Tooling stubbed       | HTTPS transport, git, gate, callClaude (dependency-injected)   |

The script's mode selector is at `scripts/proofs/run-ai-fixer-demo.sh`
top — if both keys are present it would route to a FULL flow (real PR,
real workflow run, real Claude). The synthetic flow always runs as the
covering harness so even a no-keys environment proves the wiring.

---

## 2. Setup

The synthetic harness:

1. Creates a scratch tmpdir under `os.tmpdir()`.
2. Writes a deliberately-broken file at `src/server.js` with the
   pattern `rejectUnauthorized: false` (CWE-295, MITM-vulnerable).
3. Constructs a fake CI log shaped like the real `gatetest` output:
   ```
   Run gatetest --suite quick
   ERROR: TLS / cert-validation-bypass detected
     at src/server.js:4 — rejectUnauthorized: false
   GATE BLOCKED — 1 error finding
   ```
4. Configures `env` with synthetic values (`ANTHROPIC_API_KEY=synthetic-key-for-demo`,
   `GITHUB_TOKEN=synthetic-token-for-demo`, `WORKFLOW_RUN_ID=999999999`,
   `GITHUB_REPOSITORY=ccantynz-alt/gatetest`, `CLAUDE_MODEL=claude-sonnet-4-5`).
5. Wires four stubbed GitHub responses:
   - `GET /repos/.../actions/runs/999999999` → 200 + `{html_url, head_branch}`
   - `GET /repos/.../actions/runs/999999999/jobs` → 200 + `{jobs:[{id:12345,conclusion:'failure'}]}`
   - `GET /repos/.../actions/jobs/12345/logs` → 200 + the fake CI log
   - `POST /repos/.../pulls` → 201 + `{number:4242, html_url}`
6. Stubs `callClaude` to return a known-good FILE/PATCH block:
   ```
   FILE: src/server.js
   PATCH:
   'use strict';
   const https = require('node:https');

   const agent = new https.Agent({ rejectUnauthorized: true });
   module.exports = { agent };
   END_PATCH
   ```
7. Stubs `git` to record calls and return `{ok:true}`.
8. Stubs `gate` to return `{ok:true, stdout:'all 90 modules pass'}`.

The flywheel is **explicitly disabled** via `flywheel: { available: false }`.
That decision is documented at length under **Honest caveats** below.

---

## 3. Trigger

The orchestrator was invoked as `runFixer({env, repoRoot, transport,
flywheel: {available:false}, callClaude, git, gate})` from a Node child
process spawned by the demo shell script.

In FULL mode the trigger would instead be the GitHub Actions workflow at
`.github/workflows/ai-ci-fixer.yml` (gated by the
`GATETEST_AI_CI_FIXER=1` repo variable, currently OFF per the script's
own docstring).

---

## 4. Observation — timeline

| T+ time   | Event                                                       | Source                                |
| --------- | ----------------------------------------------------------- | ------------------------------------- |
| T+0s      | Demo script starts, env check runs                          | `scripts/proofs/run-ai-fixer-demo.sh` |
| T+0s      | Mode resolved → SYNTHETIC                                   | `scripts/proofs/run-ai-fixer-demo.sh` |
| T+0s      | Node child spawned                                          | `scripts/proofs/run-ai-fixer-demo.sh` |
| T+0s      | Scratch tmpdir created                                      | `fs.mkdtempSync`                      |
| T+1s      | `src/server.js` written (5 lines, `rejectUnauthorized: false`) | Harness                            |
| T+2s      | `runFixer()` invoked                                        | `scripts/ai-ci-fixer.js:285`          |
| T+2s      | `readEnv` returns `{ok:true, ...}`                          | `lib/ai-ci-fixer-core.js:377`         |
| T+2s      | `fetchWorkflowRun` → 200 (stub)                             | `lib/ai-ci-fixer-core.js:112`         |
| T+2s      | `fetchWorkflowLogs` → 200 (stub, fake log returned)         | `lib/ai-ci-fixer-core.js:116`         |
| T+2s      | `extractFailingFiles` parses log → `["src/server.js"]`      | `lib/ai-ci-fixer-core.js:154`         |
| T+2s      | `readFilesForClaude` returns 1 file (real fs read)          | `lib/ai-ci-fixer-core.js:261`         |
| T+2s      | `attempt 1/3` begins                                        | `scripts/ai-ci-fixer.js:337`          |
| T+2s      | Flywheel skipped (`available:false`)                        | `scripts/ai-ci-fixer.js:203`          |
| T+2s      | Claude callback #1 → returns known-good patch               | Stub                                  |
| T+2s      | `parseClaudeResponse` extracts 1 FILE/PATCH block           | `lib/ai-ci-fixer-core.js:193`         |
| T+2s      | `applyPatches` writes new content to `src/server.js`        | `lib/ai-ci-fixer-core.js:280` (real)  |
| T+2s      | Gate call #1 → `{ok:true}` (stub)                           | `scripts/ai-ci-fixer.js:266`          |
| T+2s      | `attempt 1: gate is GREEN — opening PR`                     | `scripts/ai-ci-fixer.js:343`          |
| T+2s      | `openFixPr` runs: 6 git invocations (stubbed)               | `scripts/ai-ci-fixer.js:71`           |
| T+2s      |   `git config user.name gatetest-ai-fixer[bot]`             |                                       |
| T+2s      |   `git config user.email gatetest-ai-fixer@...`             |                                       |
| T+2s      |   `git checkout -B ai-fix/999999999`                        |                                       |
| T+2s      |   `git add -A`                                              |                                       |
| T+2s      |   `git commit -m "AI CI-fixer: repair workflow run ..."`   |                                       |
| T+2s      |   `git push -u origin ai-fix/999999999 --force-with-lease` |                                       |
| T+2s      | `createPullRequest` → 201 + pr/4242 (stub)                  | `lib/ai-ci-fixer-core.js:129`         |
| T+3s      | `runFixer` returns `{status:"pr-opened", attempt:1, pr:{status:201, body:{number:4242}}}` | Real return value     |
| T+3s      | Harness re-reads `src/server.js` from disk                  | `fs.readFileSync` (real)              |
| T+3s      | Verifies `rejectUnauthorized: true` is in patched content   | Regex match (real)                    |

> Times are best-effort wall clock from the actual run. The whole flow
> completed inside a single second of wall time — the table uses T+0..T+3
> to label distinct phases, not actual sub-second timing.

The captured stdout of the harness run is included verbatim below.

```
[2026-05-17T12:14:04Z] ai-fixer-demo: starting
[2026-05-17T12:14:04Z] anthropic-key (re-checked safely): MISSING
[2026-05-17T12:14:04Z] github-token  (re-checked safely): MISSING
[2026-05-17T12:14:04Z] mode: synthetic
[2026-05-17T12:14:04Z] running SYNTHETIC harness via node
[2026-05-17T12:14:04Z] [node] T+0s  building scratch repo
[2026-05-17T12:14:04Z] [node] T+1s  scratch repo at /tmp/ai-fixer-demo-PO8UOq
[2026-05-17T12:14:04Z] [node]       broken file: src/server.js (5 lines, rejectUnauthorized: false)
[2026-05-17T12:14:04Z] [node] T+2s  invoking runFixer with stubbed transport + stubbed callClaude
[ai-ci-fixer] starting fixer for ccantynz-alt/gatetest run #999999999 (model: claude-sonnet-4-5, maxAttempts: 3)
[ai-ci-fixer] identified 1 failing file(s) from log
[ai-ci-fixer] attempt 1/3
[2026-05-17T12:14:04Z] [node]       Claude call #1 — returning known-good patch
[ai-ci-fixer] attempt 1: applied 1 patch(es) (0 flywheel + 1 Claude)
[2026-05-17T12:14:04Z] [node]       gate call #1 — returning OK (stubbed: scan would pass)
[ai-ci-fixer] attempt 1: gate is GREEN — opening PR
[2026-05-17T12:14:04Z] [node]       git config user.name gatetest-ai-fixer[bot] ... (stubbed)
[2026-05-17T12:14:04Z] [node]       git config user.email gatetest-ai-fixer@users.noreply.github.com ... (stubbed)
[2026-05-17T12:14:04Z] [node]       git checkout -B ai-fix/999999999 ... (stubbed)
[2026-05-17T12:14:04Z] [node]       git add -A ... (stubbed)
[2026-05-17T12:14:04Z] [node]       git commit -m AI CI-fixer: repair workflow run https://github.com/ccantynz-alt/gatetest/actions/runs/999999999 (attempt 1) ... (stubbed)
[2026-05-17T12:14:04Z] [node]       git push -u origin ... (stubbed)
[2026-05-17T12:14:04Z] [node] T+3s  runFixer returned: status=pr-opened
[2026-05-17T12:14:04Z] [node]       file after patch: rejectUnauthorized=TRUE (fixed)
[2026-05-17T12:14:04Z] [node]       claudeCalls=1, gateCalls=1, gitCalls=6
[2026-05-17T12:14:04Z] [node]       git commit attempted: YES
[2026-05-17T12:14:04Z] [node]       git push attempted:   YES
[2026-05-17T12:14:04Z] [node]       PR opened (HTTP 201): YES — pr/4242
[2026-05-17T12:14:04Z] [node]       ASSERT: file was patched → PASS
[2026-05-17T12:14:04Z] [node]       ASSERT: result.status pr-opened → PASS
[2026-05-17T12:14:04Z] [node]       ASSERT: claudeCalls === 1 → PASS
[2026-05-17T12:14:04Z] [node]       ASSERT: gateCalls === 1 → PASS
[2026-05-17T12:14:04Z] [node]       ASSERT: git commit fired → PASS
[2026-05-17T12:14:04Z] [node]       ASSERT: git push fired → PASS
[2026-05-17T12:14:04Z] [node]       ASSERT: pr.status === 201 → PASS
[2026-05-17T12:14:04Z] [node] HARNESS PASSED: 7/7 assertions
[2026-05-17T12:14:04Z] ai-fixer-demo: done
```

---

## 5. Verification

The harness re-reads the patched file from disk after `runFixer`
returns, then runs seven independent assertions. All seven passed:

| #  | Assertion                              | Result |
| -- | -------------------------------------- | ------ |
| 1  | File was patched on disk               | PASS   |
| 2  | `result.status === "pr-opened"`        | PASS   |
| 3  | Exactly 1 Claude call                  | PASS   |
| 4  | Exactly 1 gate call                    | PASS   |
| 5  | `git commit` was invoked               | PASS   |
| 6  | `git push` was invoked                 | PASS   |
| 7  | PR-create returned HTTP 201            | PASS   |

The gate-green branch (`scripts/ai-ci-fixer.js:343`) fired, the
PR-open path (`openFixPr`) ran all six git invocations, and the real
`createPullRequest` reached the stubbed 201. The loop closed on
attempt 1 — exactly what a customer would experience for a
deterministic AST-recipe-eligible failure where Claude one-shots the
patch.

---

## 6. Cost

| Item                       | Value                               |
| -------------------------- | ----------------------------------- |
| Anthropic API tokens (in)  | 0 (synthetic mode — no real call)   |
| Anthropic API tokens (out) | 0                                   |
| Estimated USD spend        | $0.00                               |
| GitHub API calls (real)    | 0                                   |
| Wall-clock time            | ~0.2s end-to-end                    |

In FULL mode the same orchestrator code would have made one real
Anthropic call. A `rejectUnauthorized: false` fix on a 5-line file is
~150 tokens of system prompt + ~250 tokens of log + file content =
~400 input tokens, and a full-file rewrite of 5 lines is ~50 output
tokens. On `claude-sonnet-4-5` that's roughly:

```
input:  400 tokens × $3.00 / MTok  = $0.0012
output:  50 tokens × $15.00 / MTok = $0.00075
total:                              ~$0.002 per fix
```

This back-of-envelope number is **not from an actual API response** —
it's a sizing estimate. The real cost figure will be captured the first
time a FULL-mode run is recorded in this doc.

---

## 7. Reproducibility steps

From the gatetest repo root, on any branch:

```bash
# 1. (Optional) Export the keys to get FULL mode. Without them the harness
#    runs in SYNTHETIC mode and still proves the wiring end-to-end.
unset ANTHROPIC_API_KEY GITHUB_TOKEN  # force SYNTHETIC, ignore real keys

# 2. Run the demo
bash scripts/proofs/run-ai-fixer-demo.sh
```

Expected output: `HARNESS PASSED: 7/7 assertions`. Exit code 0.

To run just the underlying unit test suite (31 tests, all hermetic):

```bash
node --test tests/ai-ci-fixer.test.js
```

To inspect the entry points:

```
scripts/ai-ci-fixer.js              # orchestrator + CLI wrapper
lib/ai-ci-fixer-core.js             # GitHub API, prompt, parse, fs, gate, git
website/app/lib/ast-fixer.js        # flywheel layer 1 — AST
website/app/lib/rule-based-fixer.js # flywheel layer 2 — regex
website/app/lib/auto-distill.js     # learns recipes from Claude wins
website/app/lib/fix-telemetry.js    # telemetry records
.github/workflows/ai-ci-fixer.yml   # FULL-mode trigger workflow (gated)
```

---

## 8. Honest caveats

**This is the section the proof lives or dies by. Be ruthless.**

### 8.1 The flywheel layers are short-circuited in CI-log-driven runs

`scripts/ai-ci-fixer.js:126` calls
`flywheel.astFixer.tryAstFix(content, filePath, [])` with an **empty**
issues array. Both flywheel-layer functions return `null` immediately
when issues is empty/missing
(`website/app/lib/ast-fixer.js:405` and
`website/app/lib/rule-based-fixer.js:339`). That means for runs
triggered by a CI log — as opposed to runs triggered by the structured
findings from `/api/scan/fix` — **neither AST nor Rule layer can
fire**, and Claude is always the layer that pays for the fix.

This is not a bug per se: a CI log doesn't carry the structured
`issueRuleKey` strings the recipes match on. But it does mean the
`rejectUnauthorized: false` pattern, which is one of the 10 AST
recipes (`website/app/lib/ast-fixer.js:96-112`), would **not** be
caught by the deterministic layer in this code path. Claude pays
every time.

The harness reflects this honestly: it sets `flywheel: { available:
false }` because that's the production behaviour for CI-log runs.

A future fix to extract `issueRuleKey` strings from CI logs (e.g.
parse `ERROR: TLS / cert-validation-bypass` → `tls-security`) would
let the flywheel actually fire here.

### 8.2 The Claude response is a stub, not a real model call

In SYNTHETIC mode the harness hands `parseClaudeResponse` a hand-crafted
FILE/PATCH/END_PATCH block that's known-good. A real model run might
return malformed output, `GIVE_UP`, or a different patch shape — those
paths ARE covered by the unit tests (`tests/ai-ci-fixer.test.js` tests
9, 10, 11 plus the "Claude throws every attempt" + "unparseable
responses" cases) but not by this end-to-end harness. To turn this into
a real proof of model-driven fixing, a FULL-mode run with a real
ANTHROPIC_API_KEY against a real CI log is required.

### 8.3 The git runner is a stub

`runFixer` was passed `git: (args) => { ... return {ok:true}; }`. No
real `git` binary was invoked. The harness records and prints the six
git calls the orchestrator would have made, but it can't prove the
actual `git push --force-with-lease` against a real remote works — the
unit tests cover that path indirectly via the same stub pattern. In
FULL mode the real `spawnSync('git', ...)` runs from
`lib/ai-ci-fixer-core.js:308`.

### 8.4 The gate runner is a stub

Similarly, `gate: () => ({ok:true, ...})`. The real `runGate` at
`lib/ai-ci-fixer-core.js:300` would have spawned
`node bin/gatetest.js --suite quick` against the scratch repo. The
scratch repo doesn't contain GateTest itself, so a real gate call
would fail to find `bin/gatetest.js` and return non-zero — i.e. the
real gate runner can't be exercised in the scratch-dir layout
without significantly more setup. A FULL-mode run inside the gatetest
repo itself would close that gap.

### 8.5 No real PR was opened, no real branch was pushed

The PR-create response (201, pr/4242) is a stubbed transport reply.
No real GitHub PR exists. The Bible's "DO clean up: at the end, close
any test PR you opened" requirement is automatically satisfied —
there's nothing to close.

### 8.6 The "AST recipe shouldn't even fire" caveat

The task brief noted that if the test pattern is too easy
(`rejectUnauthorized: false` is one of our 10 AST recipes — Claude
shouldn't even fire), we should say so. Here is the honest answer:

In the SCAN/FIX path (`website/app/lib/try-fix.js` calling into
`website/app/api/scan/fix/route.ts`) the AST layer WOULD short-circuit
this fix and Claude would never see it. That's the design.

In the CI-FIXER path (this proof's path), the issue list is `[]` and
the AST layer can't fire — so Claude DOES fire even on a pattern that
has a recipe. This is the gap documented in caveat 8.1.

The synthetic harness proves the CI-fixer's Claude-driven path works.
It does **not** prove the flywheel short-circuit works for CI-log
runs, because that short-circuit doesn't currently exist for CI-log
runs.

### 8.7 No mutation testing of the patch

In production, a successful PR also runs through GateTest's
`fake-fix-detector` and (for $399 Nuclear) mutation testing. The
synthetic harness skips that — it only proves the loop closes. A real
$199 Scan+Fix PR opened by this orchestrator would include the
pair-review + regression-test generation chain (Phase 2 of the
FIX-FIRST BUILD PLAN). None of that is exercised here.

### 8.8 The task brief asked for a FULL-mode run; this is SYNTHETIC

The brief said: *"If both keys are present, run the FULL demo."*
Neither key was present in the environment. The brief's fallback was:
*"If keys are NOT present, run the SYNTHETIC demo instead."* This
document is the SYNTHETIC fallback. The FULL-mode steps are described
in the harness script's header comment and can be triggered by
re-running the same script in an environment with both secrets set.

---

## 9. What this proof DOES establish

- `runFixer({deps})` is a clean dependency-injected entry point.
- The orchestrator correctly: parses a CI log, extracts failing files,
  reads them from disk, invokes Claude (or whatever's wired in), parses
  the FILE/PATCH response, writes the patches, runs the gate, branches
  on gate result, and opens a PR on gate-green.
- The PR-open path correctly invokes the canonical 6-step git dance
  (config name, config email, checkout, add, commit, push).
- `createPullRequest` correctly returns the PR metadata back through
  the orchestrator.
- All 31 hermetic unit tests in `tests/ai-ci-fixer.test.js` still pass.
- A real customer-facing CI failure that produces a parseable log
  with file references will reach Claude and (on a known-good
  response) ship a real PR.

## 10. What this proof does NOT establish

- That Claude will produce a correct patch for an arbitrary real
  failure (covered by future FULL-mode runs).
- That the flywheel layers reduce Anthropic spend on CI-log-driven
  runs (caveat 8.1).
- That the real `git push --force-with-lease` succeeds against the
  remote (covered by integration tests at deployment).
- That `bin/gatetest.js --suite quick` actually runs in the scratch
  repo (covered by every other proof in this directory).

---

## 11. Next steps

1. **Schedule a FULL-mode run** — when an `ANTHROPIC_API_KEY` + a
   `GITHUB_TOKEN` are available in the CI environment, re-run this
   script and append the resulting timeline, real PR URL, and token
   counts as a Section 12 to this document.
2. **Close caveat 8.1** — extract structured `issueRuleKey` strings
   from CI logs (regex against the `ERROR: <module> / <rule>` shape
   GateTest emits) so the flywheel layers can fire on CI-log runs
   and reduce Anthropic spend.
3. **Validate on a real broken branch** — push a branch with
   `rejectUnauthorized: false` to a scratch repo, let CI fail,
   trigger `.github/workflows/ai-ci-fixer.yml`, observe the real PR.

These are pre-authorised under the FIX-FIRST BUILD PLAN's Phase 1.5
proof-doc requirement.

---

*Generated by Agent G (real-proof) during the bulletproof-pipeline build,
branch `ci/bulletproof-real-proof`.*
