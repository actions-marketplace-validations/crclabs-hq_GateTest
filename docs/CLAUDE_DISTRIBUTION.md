# GateTest as a Claude tool — 30-second setup

This guide is for **end customers** who want Claude to invoke GateTest on
their behalf inside any Claude session — Claude Code, Cursor, Continue,
or any other MCP-compatible client.

---

## What this gives you

Inside any Claude conversation, Claude can:

| Tool | What it does | Cost |
| --- | --- | --- |
| **`scan_remote_preview`** | Free preview of any public GitHub or Gluecron repo. Returns the top 5 findings + a total count. | **Free** (rate-limited: 1 per 10s per IP) |
| **`scan_local`** | Full 90-module scan of a local directory Claude has file access to. | **Free** (runs locally on your machine) |
| **`run_module`** | Run one specific module against a local directory. | Free |
| **`list_modules`** | List all 90 modules with descriptions. | Free |
| **`check_health`** | Verify the GateTest engine is operational. | Free |
| **`start_paid_scan`** | Get an Apple Pay / Google Pay / Stripe Link checkout URL for a paid tier. | $29 / $99 / $199 / $399 |
| **`check_remote_scan`** | Poll the result of a paid scan after the customer has paid. | Free |

The full flow inside a Claude chat looks like:

> **User:** Scan my repo at github.com/me/myapp.
> **Claude** *(invokes `scan_remote_preview`)* — *47 errors found. Top 5: …*
> **User:** Fix them all.
> **Claude** *(invokes `start_paid_scan` with tier="scan_fix")* — *That's $199. Tap to confirm: https://checkout.stripe.com/c/pay/cs_xxx*
> **User** *(taps the link, completes Apple Pay in 3 seconds)*
> **Claude** *(polls `check_remote_scan`)* — *Done. PR opened: github.com/me/myapp/pull/42*

No website navigation. No copying URLs around. One biometric tap to pay.

---

## Setup — 30 seconds

### Option A: Claude Code (recommended)

Add this to `~/.claude/mcp_servers.json` (create the file if it doesn't
exist):

```json
{
  "mcpServers": {
    "gatetest": {
      "command": "npx",
      "args": ["--yes", "-p", "github:ccantynz-alt/gatetest", "gatetest-mcp"]
    }
  }
}
```

Then restart Claude Code. The `gatetest` tools are now available to
Claude in every session. Try:

> *"Use gatetest to scan github.com/vercel/next.js and tell me the top 3 issues."*

### Option B: Self-hosted (any MCP client)

Clone the repo and point your MCP client at the binary:

```bash
git clone https://github.com/ccantynz-alt/gatetest ~/gatetest
cd ~/gatetest && npm install --production
```

Then in your MCP client config:

```json
{
  "mcpServers": {
    "gatetest": {
      "command": "node",
      "args": ["/Users/you/gatetest/bin/gatetest-mcp.mjs"]
    }
  }
}
```

### Option C: Cursor / Continue / other MCP clients

Same JSON shape as Option A, in whatever location your client reads MCP
config from. See the client's docs for the path.

---

## Configuration

Optional environment variables you can set:

| Variable | Purpose | Default |
| --- | --- | --- |
| `GATETEST_HOSTED_BASE_URL` | Override the hosted-API base. Useful if you self-host the gatetest.ai service. | `https://www.gatetest.ai` |

---

## Privacy

When Claude invokes the **remote** tools (`scan_remote_preview`,
`start_paid_scan`, `check_remote_scan`), the repo URL is sent to
gatetest.ai's hosted scanner. The scanner only reads PUBLIC repos by
default and never executes code. See https://gatetest.ai/legal/privacy
for the full policy.

The **local** tools (`scan_local`, `run_module`) run entirely on your
machine. No code, no findings, no metadata leaves your laptop. These are
the right choice when you're scanning a private codebase you have on
disk.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Preview request failed: fetch failed` | hosted service unreachable from your network | retry; check status.gatetest.ai |
| `rate limit — wait 10 seconds` | you ran two previews within 10s | wait 10s OR upgrade to Quick ($29) which has no rate limit |
| `Cannot access owner/repo — auth provider unreachable` | the repo is private (preview only works on public repos) | use `scan_local` for private repos OR upgrade to Full ($99) which has authenticated repo access |
| MCP tools don't appear in Claude | client didn't pick up the config change | restart Claude Code completely (quit + relaunch, not just reload) |
| `Unknown tool: gatetest.x` | client is using cached tool list | call `list_modules` once to force re-discovery |

---

## Pricing reminder

| Tier | Price | What you get |
| --- | --- | --- |
| Free preview | $0 | Top 5 findings, throttled |
| Quick | $29 | 4 modules (syntax / lint / secrets / codeQuality) |
| Full | $99 | All 90 modules, no auto-fix |
| Scan + Fix | $199 | All 90 + AI fix loop + PR |
| Nuclear | $399 | Everything + mutation testing + chaos pass + executive summary |

Apple Pay / Google Pay / Stripe Link / card all accepted via Stripe at
checkout. No subscription — pay per scan.

---

_Last updated: 2026-04-30. The GateTest MCP server lives at
[bin/gatetest-mcp.mjs](../bin/gatetest-mcp.mjs)._
