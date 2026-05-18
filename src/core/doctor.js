'use strict';

/**
 * GateTest Doctor — runs every prerequisite check and reports back in
 * plain English what's working, what's broken, and exactly how to fix it.
 *
 * Designed for non-experts. The output uses tick / cross / warning symbols,
 * NEVER assumes the reader knows what "ANTHROPIC_API_KEY" means, and
 * gives the exact command to fix each missing piece.
 *
 * Run: `gatetest --doctor`
 *
 * Standard-practice contract: every time a new feature adds a prerequisite
 * (env var, CLI tool, file shape, etc.), a matching check goes here. That
 * way Craig — or any customer — has ONE command to run when something feels
 * off: "is everything I need set up correctly?"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI colour codes — terminal-only; html-aware viewers will see plain text.
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function ok(msg) { return `${C.green}✓${C.reset} ${msg}`; }
function bad(msg) { return `${C.red}✗${C.reset} ${msg}`; }
function warn(msg) { return `${C.yellow}!${C.reset} ${msg}`; }
function info(msg) { return `${C.gray}·${C.reset} ${msg}`; }

/**
 * Quietly try a shell command. Returns { ok, output, error }.
 */
function trySh(cmd, opts = {}) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      ...opts,
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    return { ok: false, error: err.message || String(err), output: err.stdout || '' };
  }
}

/**
 * Test an Anthropic API key by making a tiny request and observing the
 * status code. Costs about $0.0001 per check (one input token, one output).
 *
 * Returns:
 *   { ok: true, latencyMs }                — key works
 *   { ok: false, reason: '...' }           — key missing / invalid / rate-limited
 */
async function probeAnthropic(apiKey, timeoutMs = 8000) {
  if (!apiKey) {
    return { ok: false, reason: 'ANTHROPIC_API_KEY env var is not set' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (res.status === 200) return { ok: true, latencyMs };
    if (res.status === 401) return { ok: false, reason: `key rejected (HTTP 401 — invalid or revoked)`, latencyMs };
    if (res.status === 429) return { ok: false, reason: `rate limit hit (HTTP 429 — try again in a moment)`, latencyMs };
    if (res.status === 402) return { ok: false, reason: `out of credit (HTTP 402 — top up at console.anthropic.com)`, latencyMs };
    return { ok: false, reason: `unexpected HTTP ${res.status}`, latencyMs };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: 'timeout (network or DNS issue?)' };
    return { ok: false, reason: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspect the GateTest gate workflow file in the given repo. Returns shape
 * info so we can tell the customer whether their gate is current.
 */
function inspectGateWorkflow(projectRoot) {
  const candidates = [
    '.github/workflows/gatetest-gate.yml',
    '.github/workflows/gatetest.yml',
  ];
  for (const rel of candidates) {
    const full = path.join(projectRoot, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const body = fs.readFileSync(full, 'utf8');
      return {
        present: true,
        path: rel,
        hasAutoPrFlag: body.includes('--auto-pr'),
        hasLegacyFix: body.includes('--fix') && !body.includes('--auto-pr'),
        hasAnthropicCheck: body.includes('ANTHROPIC_API_KEY'),
        hasAutoFixVar: body.includes('GATETEST_AUTOFIX'),
        bytes: body.length,
      };
    } catch (err) {
      return { present: true, path: rel, error: err.message };
    }
  }
  return { present: false };
}

/**
 * Run the full doctor sweep. Returns a structured result; the caller renders
 * to the terminal.
 *
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {boolean} opts.probeAnthropic  Set false to skip the live API ping
 */
async function runDoctor(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const lines = [];
  const summary = { ok: 0, warn: 0, bad: 0 };

  function record(kind, line, fix) {
    summary[kind] += 1;
    lines.push({ kind, line, fix });
  }

  // ── 1. Node + git environment ─────────────────────────────────────
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace(/^v/, ''), 10);
  if (major >= 20) {
    record('ok', `Node.js ${nodeVersion} (engine requires ≥20)`);
  } else {
    record('bad', `Node.js ${nodeVersion} is too old`, 'Install Node 20 or newer: https://nodejs.org');
  }

  const gitRepo = trySh('git rev-parse --git-dir', { cwd: projectRoot });
  if (gitRepo.ok) {
    const branch = trySh('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot });
    record('ok', `git repo — on branch ${branch.output || '(detached)'}`);
  } else {
    record('warn', `not a git repository at ${projectRoot}`, 'cd to a git repo (auto-PR requires git)');
  }

  // ── 2. gh CLI ─────────────────────────────────────────────────────
  const ghVer = trySh('gh --version');
  if (ghVer.ok) {
    const ghAuth = trySh('gh auth status', { env: process.env });
    if (ghAuth.ok || /Logged in/.test(ghAuth.output + ghAuth.error)) {
      record('ok', `gh CLI installed and authenticated`);
    } else {
      record('warn', `gh CLI installed but not authenticated`, 'Run: gh auth login');
    }
  } else {
    record('warn', `gh CLI not installed — auto-PR will skip`, 'Install: https://cli.github.com/  (Mac: brew install gh)');
  }

  // ── 3. ANTHROPIC_API_KEY — the big one ────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    record('bad',
      'ANTHROPIC_API_KEY is NOT set — AI auto-fix CANNOT run',
      'Local: export ANTHROPIC_API_KEY=sk-ant-...\nIn GitHub Actions: Repo Settings → Secrets and variables → Actions → New repository secret\nIn Vercel: Project → Settings → Environment Variables → Add new\nGet a key: https://console.anthropic.com/');
  } else if (!apiKey.startsWith('sk-ant-')) {
    record('warn',
      'ANTHROPIC_API_KEY is set but does not start with sk-ant- (probably invalid)',
      'Verify the value at https://console.anthropic.com/settings/keys');
  } else if (opts.probeAnthropic !== false) {
    const probe = await probeAnthropic(apiKey);
    if (probe.ok) {
      record('ok', `ANTHROPIC_API_KEY works — responded in ${probe.latencyMs}ms`);
    } else {
      record('bad',
        `ANTHROPIC_API_KEY set but not working: ${probe.reason}`,
        'Check your key at https://console.anthropic.com/settings/keys');
    }
  } else {
    record('ok', `ANTHROPIC_API_KEY is set (skipped live check)`);
  }

  // ── 4. GateTest workflow file ─────────────────────────────────────
  const wf = inspectGateWorkflow(projectRoot);
  if (!wf.present) {
    record('warn',
      'GateTest workflow file not found in .github/workflows/',
      `Install: curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash`);
  } else if (wf.error) {
    record('warn', `workflow file present but unreadable: ${wf.error}`, '');
  } else if (wf.hasAutoPrFlag) {
    record('ok', `workflow at ${wf.path} — current version (supports --auto-pr)`);
  } else if (wf.hasLegacyFix) {
    record('warn',
      `workflow at ${wf.path} — legacy version (uses --fix not --auto-pr — only lint-fixers, no AI fixes)`,
      'Update: re-run installer to pull the latest gatetest-gate.yml');
  } else {
    record('warn',
      `workflow at ${wf.path} — no auto-repair step at all (very old)`,
      'Update: re-run installer');
  }

  // ── 5. GitHub token (for CI environments) ─────────────────────────
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) {
    record('ok', `GITHUB_TOKEN / GH_TOKEN set in environment (CI mode)`);
  } else if (!ghVer.ok) {
    record('warn', `no GITHUB_TOKEN set AND no gh CLI — auto-PR has no way to authenticate`, 'Either set GH_TOKEN, or install gh CLI and run gh auth login');
  } else {
    record('info', `no GITHUB_TOKEN env var — relying on gh CLI auth instead (fine for local use)`);
  }

  // ── 6. Gluecron auth (optional — only if using dual-host) ─────────
  if (process.env.GLUECRON_API_TOKEN) {
    const token = process.env.GLUECRON_API_TOKEN;
    if (token.startsWith('glc_')) {
      record('ok', `GLUECRON_API_TOKEN set (length ${token.length})`);
    } else {
      record('warn', `GLUECRON_API_TOKEN set but doesn't start with glc_ — probably invalid`, 'Generate a new PAT at https://gluecron.com/settings/tokens');
    }
  } else {
    record('info', `GLUECRON_API_TOKEN not set (only needed if using Gluecron as your git host)`);
  }

  // ── 6b. Public API platform — for third-party integration partners ────
  // The /api/v1/* endpoints expose GateTest as a platform that ANY external
  // SaaS can integrate with. These checks verify the env is configured for
  // partner-facing API traffic.
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    record('ok', `NEXT_PUBLIC_BASE_URL set to ${process.env.NEXT_PUBLIC_BASE_URL} (partners hit this for /api/v1/*)`);
  } else {
    record('warn',
      'NEXT_PUBLIC_BASE_URL not set — partners will see localhost URLs in webhook payloads',
      'Set NEXT_PUBLIC_BASE_URL=https://gatetest.ai in Vercel env vars');
  }

  if (process.env.DATABASE_URL) {
    record('ok', `DATABASE_URL set (Postgres backing for api_keys + scan_queue + audit_log)`);
  } else {
    record('bad',
      'DATABASE_URL not set — public API cannot authenticate keys or queue scans',
      'Set DATABASE_URL=postgres://... in Vercel env vars');
  }

  // ── 7. Disk space (lightweight check — Vercel /tmp + local) ───────
  try {
    const diskCheck = trySh('df -h .', { cwd: projectRoot });
    if (diskCheck.ok) {
      record('info', `disk: ${diskCheck.output.split('\n').slice(-1)[0]}`);
    }
  } catch { /* not fatal */ }

  return { lines, summary, projectRoot };
}

/**
 * Render the doctor result to the terminal.
 */
function renderDoctor(result) {
  const out = [];
  out.push('');
  out.push(`${C.bold}${C.cyan}GATETEST DOCTOR${C.reset} — environment audit`);
  out.push(`${C.gray}─────────────────────────────────────${C.reset}`);
  out.push(`${C.gray}Project root:${C.reset} ${result.projectRoot}`);
  out.push('');

  for (const { kind, line, fix } of result.lines) {
    if (kind === 'ok') out.push('  ' + ok(line));
    else if (kind === 'warn') out.push('  ' + warn(line));
    else if (kind === 'bad') out.push('  ' + bad(line));
    else if (kind === 'info') out.push('  ' + info(line));
    if (fix && (kind === 'bad' || kind === 'warn')) {
      const fixLines = fix.split('\n');
      for (const f of fixLines) {
        out.push(`     ${C.gray}└─ Fix:${C.reset} ${f}`);
      }
    }
  }

  out.push('');
  const { ok: passCount, warn: warnCount, bad: badCount } = result.summary;
  const totalIssues = warnCount + badCount;
  if (badCount > 0) {
    out.push(`  ${C.red}${C.bold}${badCount} error(s)${C.reset}, ${C.yellow}${warnCount} warning(s)${C.reset}, ${C.green}${passCount} OK${C.reset}`);
    out.push(`  ${C.red}Action needed.${C.reset} See "Fix:" lines above — each is the exact command or steps.`);
  } else if (warnCount > 0) {
    out.push(`  ${C.yellow}${warnCount} warning(s)${C.reset}, ${C.green}${passCount} OK${C.reset}`);
    out.push(`  ${C.yellow}Auto-fix may work but some features are degraded.${C.reset} Address warnings above when convenient.`);
  } else {
    out.push(`  ${C.green}${C.bold}Everything looks good${C.reset} — ${passCount} checks passed, no issues found.`);
    out.push(`  Auto-fix should fire on the next failing gate run.`);
  }
  out.push('');

  return out.join('\n');
}

module.exports = { runDoctor, renderDoctor, probeAnthropic, inspectGateWorkflow };
