# Publishing GateTest — every channel

> **One-page playbook.** All commands are Craig-runnable. Each requires a
> credential or scope GateTest doesn't already have, which is why these
> live in the Boss Rule list.

---

## 1. npm — public registry

**Why:** lets anyone run `npm install -g gatetest` or `npx gatetest`.

### Path A — automated via GitHub Actions (recommended)

`.github/workflows/publish.yml` runs `npm publish` on every `v*` tag push.
`prepublishOnly` runs `--list` + the full test suite first, so a broken
state can't reach the registry. `--provenance` is enabled so the npm
listing shows the GitHub-Actions-signed build.

**One-time setup (~2 minutes):**

1. On your laptop (still requires `npm login` ONCE, ever):
   ```bash
   npm login
   npm token create        # outputs: npm_xxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
2. In GitHub: repo → Settings → Secrets and variables → Actions → New
   repository secret:
   - Name:  `NPM_TOKEN`
   - Value: the `npm_xxxxxxxx` string from step 1

That's it. From then on, every release is one command:

```bash
npm version patch               # 1.0.0 -> 1.0.1, creates tag, commits
git push --follow-tags          # actions runs: test -> publish -> release
```

The workflow also creates a GitHub Release with auto-generated notes
from commit messages between tags.

**Manual trigger / dry-run:** Actions tab → "Publish to npm" → Run
workflow → tick "Dry-run only" if you want to verify without publishing.

### Path B — fully manual from your laptop

If you ever need to bypass GitHub Actions (account migration, registry
URL change, etc.):

```bash
npm login                       # if not already logged in
npm version patch               # bump
npm publish --access public     # prepublishOnly still runs the gate
```

**Verify:**
```bash
npm view gatetest version       # should match what you just published
npx -y gatetest --list          # smoke-test from a clean dir
```

**If `npm publish` fails with 403 / E402:**
- The package name is taken or the npm account isn't authorised.
- Resolve via `npm whoami` and the npmjs.com web UI before retrying.

---

## 2. Homebrew tap — Mac-native install

**Why:** `brew install gatetest` for Mac users.

**One-time setup (once ever):**
1. Create a public repo `ccantynz-alt/homebrew-gatetest`.
2. Copy `integrations/homebrew/gatetest.rb` into the root of that repo as `Formula/gatetest.rb`.

**Every release after npm publish:**
```bash
# 1. Get the SHA256 of the freshly-published tarball
curl -sL https://registry.npmjs.org/gatetest/-/gatetest-$(npm view gatetest version).tgz \
  | shasum -a 256

# 2. In the homebrew-gatetest repo, edit Formula/gatetest.rb:
#    - bump url to the new version
#    - replace the sha256 with the value from step 1
# 3. Commit + push
```

**Users then run:**
```bash
brew tap ccantynz-alt/gatetest
brew install gatetest
```

---

## 3. GitHub Marketplace — App distribution

**Why:** distribution channel. Listed alongside Snyk, CodeQL, etc.

**One-time setup (Craig action, ~2-3 weeks GitHub approval):**
1. Go to the GitHub App settings for **GateTestHQ**.
2. Click "List on Marketplace."
3. Upload logo + screenshots from `integrations/marketplace/screenshots.md`.
4. Use copy from `integrations/marketplace/listing.md`.
5. Choose free-tier-with-upsell pricing model.
6. Submit for review.

After approval, the app appears at `github.com/marketplace/gatetest`.

---

## 4. MCP server — Claude Code / Cursor / Cline / Aider

**Why:** AI-builder distribution. No GitHub Marketplace approval needed.

The MCP server already ships in the npm package as `gatetest-mcp`. Once
GateTest is on npm, MCP-aware AI builders can use it via:

```jsonc
{
  "mcpServers": {
    "gatetest": {
      "command": "npx",
      "args": ["-y", "gatetest-mcp"]
    }
  }
}
```

**No separate publish step required.** Lands the moment npm publish succeeds.

---

## 5. drop-in CI gate — already live

`integrations/scripts/install.sh` already serves a one-shot install via
`curl | bash` from the public raw.githubusercontent.com URL. No publish
step — works the moment the file is on `main`.

---

## Channel matrix — what one publish enables

| Channel | Install command | Requires |
| --- | --- | --- |
| npm | `npm i -g gatetest` / `npx gatetest` | npm publish (Craig) |
| MCP | `npx gatetest-mcp` | npm publish (Craig) |
| Homebrew | `brew install ccantynz-alt/gatetest/gatetest` | tap repo + formula bump (Craig) |
| Drop-in CI | `curl ... | bash` | Already live (no action) |
| Hosted SaaS | gatetest.ai | Already live |
| GitHub Marketplace | Install from marketplace | App listing approval (Craig, 2-3 weeks) |

---

## Pre-publish checklist (before every `npm publish`)

- [ ] `node --test tests/*.test.js` — green
- [ ] `node bin/gatetest.js --list` — all 90 modules load
- [ ] `cd website && npx next build` — clean build
- [ ] CLAUDE.md `## VERSION` reflects what's shipping
- [ ] README module count matches `--list` output
- [ ] CHANGELOG.md entry added (if you keep one)
- [ ] `npm version <patch|minor|major>` has been run (creates the git tag)
- [ ] `git push --follow-tags`

`prepublishOnly` in package.json runs the test + module-load gate
automatically, so a broken state can't reach the registry.
