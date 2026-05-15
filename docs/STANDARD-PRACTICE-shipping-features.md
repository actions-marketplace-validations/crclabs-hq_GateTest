# Standard practice — shipping a feature

> Authorisation: Craig 2026-05-15 — *"we need a better relationship I need to know what's happening I'm not an expert so I need to know if something's not working or not set or if there's anything else we need to do please standard practise moving forward can we lock that in."*
>
> This document is the contract every future Claude session reads at start-of-session and follows. It exists because Craig is not a developer expert; the tool must make its own configuration state self-evident without him having to ask.

## The rule

**A feature is not shipped until the customer can actually use it in production.** Code that compiles is not shipped. Code that passes tests is not shipped. Code that's pre-authorised is not shipped. Code that the customer's environment can run AND the customer knows is working — that's shipped.

## The five-step contract — every feature, every time

When I ship any feature that touches the customer experience, I will do all five of these before saying "shipped":

### 1. Enumerate every prerequisite

In the same commit message AND the response to Craig, list every prerequisite. Examples:

- Environment variables (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GLUECRON_API_TOKEN`, ...)
- CLI tools the feature shells out to (`gh`, `git`, `npm`, ...)
- File / workflow versions ("requires `--auto-pr` flag = workflow v1.2+")
- Account states ("requires gh CLI authenticated via `gh auth login`")
- Stripe / DNS / external services
- Vercel env vars vs GitHub secrets vs local env — which goes where

### 2. Add the prerequisite to `gatetest --doctor`

If the feature has a prerequisite that could be missing in Craig's environment, the `--doctor` command must check for it and report:

- `ok` if it's present and working
- `warn` if missing but optional / degrades gracefully
- `bad` if missing and the feature CANNOT work

Each `warn`/`bad` finding must include a copy-paste fix command in plain English.

### 3. Verify in Craig's actual environment (not just unit tests)

For any feature that runs in production, I will either:

- (a) Run a real end-to-end smoke test against the production environment, OR
- (b) Explicitly state "I cannot verify in production from this session — when you're at the keyboard, please run X to confirm"

Never assume. Never say "should work."

### 4. Surface unmet prerequisites in the same message as the announcement

When I tell Craig a feature is shipped, the message must end with:

```
Prerequisites for this to actually work in production:
  ✓ <thing already verified>
  ⚠ <thing Craig needs to do — with exact steps>
```

If everything is verified, the message says so. If anything is unverified, the message says THAT.

### 5. Proactive status check at session start

When a session resumes, before working on anything new, I run `gatetest --doctor --doctor-quick` against the current repo and surface any new `bad` findings. If a feature I previously shipped has stopped working because a prerequisite was lost, I tell Craig in the first message of the session.

## What this looks like in practice

### Bad (what I did before)

> "Shipped the `--auto-pr` flag — the CLI now opens a fix PR automatically when the gate fails. Pushed `eadc199`."

Craig has no way to know: he needs ANTHROPIC_API_KEY set, gh CLI installed, the new workflow file deployed. Three invisible prerequisites. Result: he asks "why isn't auto-fix working?" because nothing is.

### Good (what I do now)

> "Shipped the `--auto-pr` flag (commit `eadc199`).
>
> **Prerequisites for this to fire in production:**
>
> | # | Need | State on your end | Fix if missing |
> |---|---|---|---|
> | 1 | `ANTHROPIC_API_KEY` set as a GitHub secret on the failing repo | ⚠ I can't see this from here — please run `gatetest --doctor` in that repo OR check Settings → Secrets and variables → Actions | Add the secret at the **org level** so every repo gets it |
> | 2 | Workflow file is the current version (has `--auto-pr` line) | ⚠ Depends on when `install.sh` was last run on that repo | Re-run the installer: `curl -sSL .../install.sh \| bash` |
> | 3 | `gh` CLI installed on the runner | ✓ default on `ubuntu-latest` GitHub-hosted runners | n/a |
> | 4 | `GATETEST_AUTOFIX` repo variable not set to `off` | ⚠ Default is unset (= on) | If it's set to `off`, change to `on` |
>
> **Next action you can take in 30 seconds:** run `gatetest --doctor` in the failing repo from your terminal. It will tell you in plain English exactly which of the 4 prerequisites is missing."

Craig now knows: there are four things, here's the state of each, here's the fix, here's how to check.

## The doctor command — single source of truth

The `gatetest --doctor` command is the embodiment of this practice. Craig can run it any time and get a plain-English audit of his environment. Every prerequisite check lives there. Every new feature adds its check there.

Output shape (real example from this session):

```
GATETEST DOCTOR — environment audit
─────────────────────────────────────
Project root: /home/user/GateTest

  ✓ Node.js v22.22.2 (engine requires ≥20)
  ✓ git repo — on branch claude/launch-prep
  ! gh CLI not installed — auto-PR will skip
     └─ Fix: Install: https://cli.github.com/  (Mac: brew install gh)
  ✗ ANTHROPIC_API_KEY is NOT set — AI auto-fix CANNOT run
     └─ Fix: Local: export ANTHROPIC_API_KEY=sk-ant-...
     └─ Fix: In GitHub Actions: Repo Settings → Secrets and variables → Actions → New repository secret
     └─ Fix: In Vercel: Project → Settings → Environment Variables → Add new
     └─ Fix: Get a key: https://console.anthropic.com/
  ! GateTest workflow file not found in .github/workflows/
     └─ Fix: Install: curl -sSL https://.../install.sh | bash

  1 error(s), 3 warning(s), 2 OK
  Action needed. See "Fix:" lines above — each is the exact command or steps.
```

Plain English. Symbol-coded. Copy-paste fixes. No expertise required.

## How to use the doctor — for Craig

Run it any time you suspect something isn't working:

```bash
gatetest --doctor              # Full check (pings Anthropic API to verify key works)
gatetest --doctor-quick        # Same but skips the network ping (offline mode)
```

If you're checking a specific repo:

```bash
cd /path/to/that/repo
gatetest --doctor
```

What each symbol means:

- `✓` (green tick) — this is set up correctly
- `!` (yellow exclamation) — this is missing but the tool can still partially work
- `✗` (red cross) — this is missing AND the feature won't work at all until you fix it
- `·` (gray dot) — informational, no action needed

The summary line at the bottom tells you whether action is needed.

## Lock-in points

For this practice to actually stick:

1. **This file is read at the start of every session** (alongside CLAUDE.md). Future Claude sessions follow this contract by reading it.
2. **The `gatetest --doctor` command must be kept up to date.** Every new feature with a prerequisite adds its check to `src/core/doctor.js`. Without that, the feature is "shipped without doctor coverage" and doesn't pass the standard.
3. **Craig's escape valve.** Whenever Craig asks "why isn't X working?" — the first response is to run `gatetest --doctor` and report what it found. No more guessing.
4. **The CLAUDE.md sweep checklist gets one new item:** "After shipping any customer-facing feature, prerequisite checks added to `src/core/doctor.js`?" — to be added in a follow-up edit of the Bible.

## What this doesn't fix

The doctor command is a static-time check. It tells you what's set up right NOW. It doesn't:

- Watch your CI runs in real-time (you'd need a webhook + alerting layer for that)
- Tell you when your Anthropic balance drops below $5 (separate billing monitoring needed)
- Detect when a workflow file was tampered with on a protected platform

Those are real gaps. They can each be filled with separate tooling, but they're additional layers ON TOP of the doctor command, not replacements for it.
