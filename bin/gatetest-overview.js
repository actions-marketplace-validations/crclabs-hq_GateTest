#!/usr/bin/env node
/**
 * gatetest-overview — admin overview CLI
 *
 * Fetches GET /api/admin/overview using ADMIN_TOKEN, then pretty-
 * prints the JSON as a human-readable table.
 *
 * Env:
 *   ADMIN_TOKEN          — bearer token (required)
 *   GATETEST_ADMIN_URL   — base URL, default http://localhost:3333
 *
 * Flags:
 *   --json               — print the raw JSON instead of the table
 *   --url <u>            — override base URL
 *
 * Exit code:
 *   0 — all repos fresh and no critical issues
 *   1 — stale repo(s) or any critical issue (or fetch/auth failure)
 *
 * No external deps (uses http/https just like src/app-server.js).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function parseArgs(argv) {
  const args = { json: false, url: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: gatetest-overview [--json] [--url <base-url>]

Env:
  ADMIN_TOKEN          Bearer token (required)
  GATETEST_ADMIN_URL   Base URL (default: http://localhost:3333)

Exit code:
  0 — healthy (no stale repos, no critical issues)
  1 — stale repo(s) or critical issue(s), or fetch error
`);
}

function fetchOverview(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/admin/overview', baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'gatetest-overview-cli/1.0.0',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Invalid JSON: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function rpad(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function renderTable(data) {
  const lines = [];
  lines.push('GateTest Admin Overview');
  lines.push('='.repeat(72));
  lines.push(`Repos monitored:        ${data.repos_monitored}`);
  lines.push(`Total scans (24h):      ${data.total_scans_24h}`);
  lines.push(`Total open issues:      ${data.total_issues_open}`);
  lines.push(`Auto-fixes applied (7d):${data.total_fixes_applied_7d}`);
  if (data._stub) {
    lines.push('(note: served from stub data — no reports on disk)');
  }
  lines.push('');
  lines.push('Per-repo breakdown');
  lines.push('-'.repeat(72));
  lines.push(
    pad('REPO', 32) + pad('LAST SCAN', 22) + rpad('C', 3) + rpad('H', 3)
    + rpad('M', 3) + rpad('L', 3) + rpad('FIX7D', 7)
  );
  for (const r of data.repos) {
    const sev = r.open_issues_by_severity || { critical: 0, high: 0, medium: 0, low: 0 };
    lines.push(
      pad(r.name, 32)
      + pad(r.last_scan || '(never)', 22)
      + rpad(sev.critical, 3)
      + rpad(sev.high, 3)
      + rpad(sev.medium, 3)
      + rpad(sev.low, 3)
      + rpad(r.auto_fixes_7d, 7)
    );
  }
  lines.push('');

  if (data.stale_repos && data.stale_repos.length > 0) {
    lines.push(`Stale repos (${data.stale_repos.length}):`);
    for (const s of data.stale_repos) lines.push(`  - ${s}`);
    lines.push('');
  } else {
    lines.push('Stale repos: none');
    lines.push('');
  }

  lines.push('Recent activity');
  lines.push('-'.repeat(72));
  const feed = (data.activity_feed || []).slice(0, 10);
  if (feed.length === 0) {
    lines.push('  (no activity)');
  } else {
    for (const a of feed) {
      lines.push(`  [${a.ts}] ${a.repo} ${a.event} — ${a.detail}`);
    }
  }

  return lines.join('\n');
}

function hasCritical(data) {
  for (const r of (data.repos || [])) {
    const sev = r.open_issues_by_severity || {};
    if ((sev.critical || 0) > 0) return true;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('error: ADMIN_TOKEN env var is required');
    process.exit(1);
  }
  const baseUrl = args.url || process.env.GATETEST_ADMIN_URL || 'http://localhost:3333';

  let data;
  try {
    data = await fetchOverview(baseUrl, token);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(renderTable(data) + '\n');
  }

  const stale = (data.stale_repos || []).length > 0;
  const critical = hasCritical(data);
  process.exit(stale || critical ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
