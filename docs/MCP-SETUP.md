# GateTest MCP Server — Setup Guide

GateTest ships an MCP server. Any MCP-compatible AI (Claude Code, Cursor,
Continue, Windsurf, etc.) can call GateTest directly — no webhooks, no web
app, no external infrastructure required.

## What it gives you

- **Offline fallback** — if GitHub webhooks or Gluecron are unreachable, scan
  any local repo from the AI session instantly
- **AI-native quality gate** — Claude can run a scan before suggesting a fix,
  verify the fix didn't introduce new issues, and report findings inline
- **Four tools exposed:**
  - `scan_local` — scan a directory with any suite or specific modules
  - `run_module` — run one module (e.g. `secrets`, `tlsSecurity`, `importCycle`)
  - `list_modules` — list all 102 modules with descriptions
  - `check_health` — verify the engine is operational

---

## Claude Code (CLI / Web)

Add to `.claude/settings.json` in your project (or `~/.claude/settings.json`
globally):

```json
{
  "mcpServers": {
    "gatetest": {
      "command": "node",
      "args": ["/absolute/path/to/GateTest/bin/gatetest-mcp.mjs"]
    }
  }
}
```

Or if GateTest is installed globally (`npm install -g gatetest`):

```json
{
  "mcpServers": {
    "gatetest": {
      "command": "gatetest-mcp"
    }
  }
}
```

Then in a Claude Code session you can say:

> "Run a GateTest secrets scan on this repo"
> "Check this codebase with GateTest before we deploy"
> "What modules does GateTest have for detecting race conditions?"

---

## Cursor / Windsurf / Continue

Use the same JSON config format in the respective MCP settings panel.
The server uses stdio transport — compatible with all MCP clients.

---

## Direct usage (any terminal)

```bash
# List all tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node bin/gatetest-mcp.mjs

# Scan current directory
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"scan_local",
  "arguments":{"path":"/your/project","suite":"quick"}
}}' | node bin/gatetest-mcp.mjs

# Run a single module
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"run_module",
  "arguments":{"module":"secrets","path":"/your/project"}
}}' | node bin/gatetest-mcp.mjs
```

---

## When to use MCP vs the GitHub App vs Gluecron

| Scenario | Best path |
|---|---|
| Developer has Claude Code open, wants instant scan | **MCP** |
| Push to GitHub repo, need automated CI gate | **GitHub App webhook** |
| Gluecron-hosted repo, push event | **Gluecron Signal Bus** |
| GitHub/Gluecron unreachable, proxy issues | **MCP — zero external dependencies** |
| WordPress site / non-git codebase | **MCP** (`scan_local` with the site path) |

---

## Suite options

| Suite | Modules | Use when |
|---|---|---|
| `quick` | 4 core modules | Fast gate, <5s |
| `standard` | ~20 modules | Default, balanced |
| `full` | All 102 modules | Pre-deploy, thorough |

Or pass `modules: ["secrets", "tlsSecurity", "importCycle"]` to run specific
modules only.
