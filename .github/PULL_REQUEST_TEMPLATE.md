<!--
Thanks for sending a PR. Keep it small and focused — one fix, one test.
The Bible (CLAUDE.md) is required reading before any non-trivial change.
-->

### What this changes

<!-- One or two sentences. -->

### Why

<!-- Link the issue this closes (e.g. "Closes #123"), or describe the user-visible reason. -->

### How it was tested

- [ ] `node --test tests/*.test.js` — all pass locally
- [ ] `node bin/gatetest.js --list` — all modules still load
- [ ] (if website touched) `cd website && npx next build` — zero errors
- [ ] Added or updated tests for the new behaviour

### Checklist

- [ ] Read [CLAUDE.md](../CLAUDE.md) and confirmed this change does not require Craig's authorization (Boss Rule items: pricing, DNS, Stripe, dependencies, external APIs, brand copy, production deploys, anything touching money / user data / public comms).
- [ ] No `console.log` left in library code, no `debugger` statements, no unresolved `TODO`/`FIXME` in changed lines.
- [ ] Commit messages follow the project style (look at `git log --oneline -10` for the pattern).

### Notes for the reviewer

<!-- Anything you want the reviewer to look at first. Tricky bits, design trade-offs, follow-up work. -->
