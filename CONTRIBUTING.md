# Contributing to GateTest

Thanks for considering a contribution. This document is intentionally short. The full architectural rulebook lives in [CLAUDE.md](CLAUDE.md) — read it before any non-trivial change.

## Getting set up

```bash
git clone https://github.com/ccantynz-alt/gatetest
cd gatetest
npm install
(cd website && npm install)

# Smoke check — both should succeed
node --test tests/*.test.js
node bin/gatetest.js --list
```

Node 20 or newer is required. The gate itself has effectively zero runtime dependencies; the website has a normal Next.js dependency footprint.

## Quick contribution loop

1. **Open an issue first** if the change is non-trivial. A two-sentence proposal saves both of us a wasted PR.
2. **Branch off `main`** with a short prefix: `fix/`, `feat/`, `docs/`, `chore/`, `test/`.
3. **Write the test first** when adding a new module or rule. Tests live in `tests/<module-name>.test.js`. Look at any existing module for the shape — `tests/secrets.test.js` is a good template.
4. **Run the full suite locally** before pushing: `node --test tests/*.test.js`. Green means green.
5. **Open a PR** using the template. Small PRs are merged fastest; mixed-concern PRs are sent back.

## Anatomy of a module

Every scanner extends `BaseModule` from `src/modules/base.js`. The contract is:

```javascript
import { BaseModule } from "./base.js";

export class MyModule extends BaseModule {
  constructor() {
    super("myModule", "Short one-line description shown in --list");
  }

  async run(result, config) {
    // result.addCheck({ name, status, severity, detail })
    // severity is one of: error / warning / info
  }
}
```

Then register it in `src/core/registry.js` and (if it belongs to a suite) add it to the suite list in `src/core/config.js`.

## What needs Craig's authorization

The Bible lists nine categories that need explicit authorization before code lands — major architectural changes, new dependencies, pricing changes, DNS, production deployments, Stripe configuration, external API integrations, brand and marketing changes, and anything touching money or user data or public-facing communication. When in doubt, open an issue and ask.

## What does not need authorization

Routine bug fixes, refactors inside the approved stack, new test cases, doc improvements, new modules that follow the existing pattern, and small UX polish on the website. The pre-authorization is documented in [CLAUDE.md](CLAUDE.md) under "THE BOSS RULE — CRAIG MUST AUTHORIZE".

## Style notes

- No emojis in user-facing text (CLI output, README, comments shown to users).
- Function length under fifty lines, file length under three hundred lines.
- Every new module ships with at least one test file at `tests/<name>.test.js`.
- Conventional-commit-flavoured messages (`feat:`, `fix:`, `docs:`, `chore:`). Look at recent commits for the in-house dialect.

## Where to ask

- [GitHub Issues](https://github.com/ccantynz-alt/gatetest/issues) — bugs, feature requests, public discussion.
- Live chat on [gatetest.ai](https://gatetest.ai) — fastest reply.

That is the whole guide. Open the PR.
