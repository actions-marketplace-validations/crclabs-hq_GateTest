# GateTest — Platform Integration

**This directory is a PROTECTED INTEGRATION ARTIFACT.** It must not be deleted,
renamed, or weakened by any future session. See the root `CLAUDE.md` →
**PROTECTED PLATFORMS** section.

---

## What this is

GateTest is sold as a **standalone subscription product** on gatetest.ai.
This directory contains drop-in artifacts so the same engine can also protect
Craig's internal platforms **without making GateTest non-standalone.**

Today's protected platforms:

| Platform     | Repository                                         |
| ------------ | -------------------------------------------------- |
| Crontech.ai  | https://github.com/ccantynz-alt/Crontech           |
| Gluecron.com | https://github.com/ccantynz-alt/Gluecron.com       |

Every push and PR on those repos runs the full GateTest quality gate.
Broken code is rejected before it ships.

---

## How to install into a new repo (60 seconds)

From the root of the target repository:

```bash
curl -sSL https://raw.githubusercontent.com/ccantynz-alt/gatetest/main/integrations/scripts/install.sh | bash
git add .github .husky .gatetest.json
git commit -m "chore: install GateTest quality gate"
git push
```

That installs three things:

1. `.github/workflows/gatetest-gate.yml` — CI quality gate on every push/PR
2. `.husky/pre-push` — local pre-push hook (requires `npx husky init` once)
3. `.gatetest.json` — protection marker telling future automation this repo is protected

---

## Turn ON auto-fix (one secret, every repo, forever)

The gate **finds** issues out of the box. To also **fix** them automatically,
set ONE Anthropic API key as a GitHub organization secret and every repo in
your org starts opening surgical-fix PRs the moment a scan fails:

1. Go to `https://github.com/organizations/<your-org>/settings/secrets/actions`
2. Click **New organization secret**
3. Name: `ANTHROPIC_API_KEY`
4. Value: your Anthropic API key (`sk-ant-…`)
5. Repository access: **All repositories** (or **Selected**)
6. Save

That's it. The next failed gate run on any repo in your org will:
- Run `gatetest --suite quick --auto-pr` — calls the AI fix engine for every
  finding with a file path, applies the Claude-generated fixes, commits them,
  and opens a PR via the `gh` CLI (one CLI call, no extra workflow steps)
- Open a `gatetest/auto-repair-<run-id>` branch with the fixes
- Generate a PR body that lists every finding, marked ✅ (fixed) or
  ⚠️ (couldn't fix), so reviewers see what AI handled and what they need
  to do manually
- The original failing PR stays untouched — it remains blocked until the
  auto-fix PR is merged

To **disable** auto-fix on a specific repo: Settings → Secrets and variables
→ Actions → Variables tab → New repository variable → `GATETEST_AUTOFIX = off`.

### Manual use outside CI

The same flow works on any developer machine:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
gh auth login                                  # if not already logged in
git checkout -b your-feature
# … make some changes …
gatetest --suite quick --auto-pr               # gate runs, AI fixes what
                                               # it can, opens a PR
```

Cap: at most 50 fixes per `--auto-pr` invocation, bounded to keep Anthropic
spend predictable. Re-run after merging the auto-fix PR to handle any
remaining findings.

When the key is **missing**, the workflow prints a one-shot setup hint at
the end of every failed run so a new dev can self-serve the activation.

---

## Architecture — why GateTest stays standalone

```
┌────────────────────────────────┐        ┌──────────────────────────┐
│  gatetest (this repo)          │        │  Crontech / Gluecron     │
│  - sold as subscription        │        │  - consumes GateTest     │
│  - product on gatetest.ai      │        │  - no code copied in     │
│  - zero deps, clones in CI     │◄───────┤  - updates automatically │
└────────────────────────────────┘        └──────────────────────────┘
```

Target repos clone GateTest at CI time — nothing is vendored, nothing is forked,
nothing is duplicated. Ship a fix to GateTest → every protected platform picks
it up on the next CI run. Compounding moat, not drift.

---

## Protection rules

1. **NEVER** delete `integrations/` from this repo.
2. **NEVER** delete `.github/workflows/gatetest-gate.yml` from a protected repo.
3. **NEVER** delete `.husky/pre-push` from a protected repo.
4. **NEVER** delete `.gatetest.json` from a protected repo — it is the marker.
5. **NEVER** add `continue-on-error: true` to the gate step.
6. **NEVER** let a future Claude session "simplify" these files away.

Any change that weakens protection requires Craig's explicit authorization.
See the Bible → **THE FORBIDDEN LIST**.
