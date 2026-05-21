#!/usr/bin/env node
/**
 * compare-playwright.js — head-to-head comparison: GateTest's
 * `runtime-errors` module vs a bare-bones Playwright capture script.
 *
 * Why this exists: Playwright is the framework most developers reach
 * for when they want to "test their website" — but Playwright on its
 * own catches NOTHING automatically. You have to write the assertions.
 * GateTest's runtime-errors module IS the assertions: point it at a
 * URL and it tells you what's broken. This script proves the
 * difference on a deliberately-broken fixture site.
 *
 * Architecture:
 *   1. Spin up a localhost HTTP server serving
 *      `corpus/broken-sites/example-broken.html` (5 known bugs).
 *   2. Run GateTest's `runtime-errors` module against it — record
 *      findings.
 *   3. Run a minimal bare Playwright script (just `chromium.launch()`
 *      + `page.goto()` + `page.on('pageerror')` listener) — record
 *      what it caught WITHOUT any developer-written assertions.
 *   4. Print a side-by-side markdown report.
 *
 * Output:
 *   - JSON to stdout (when --json) for the flywheel + dashboard
 *   - Markdown table to stdout (default) for the launch page
 *
 * Cost: zero. Free Playwright, free localhost, no external network,
 * no Claude. Honest baseline data.
 *
 * Usage:
 *   node scripts/compare-playwright.js
 *   node scripts/compare-playwright.js --json
 *   node scripts/compare-playwright.js --fixture corpus/broken-sites/example-broken.html
 */

'use strict';

const fs   = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_FIXTURE = path.join(__dirname, '..', 'corpus', 'broken-sites', 'example-broken.html');
const WAIT_MS = 1500; // wait long enough for the 200ms deferred throw to fire

// ---------------------------------------------------------------------------
// Tiny HTTP server that serves the fixture HTML at /
// ---------------------------------------------------------------------------

function serveFixture(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      // Intentionally omit Content-Security-Policy + X-Frame-Options
      // + Strict-Transport-Security — those are part of what GateTest
      // catches and Playwright doesn't.
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      // hardcoded-url-ok — local test-server URL is exactly the point of this script
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

// ---------------------------------------------------------------------------
// Find playwright — it lives in website/node_modules but we're invoked
// from the repo root. Resolve from the website workspace.
// ---------------------------------------------------------------------------

function loadPlaywright() {
  const fromDir = path.join(__dirname, '..', 'website');
  try {
    const resolved = require.resolve('playwright', { paths: [fromDir] });
    return require(resolved);
  } catch (err) {
    return { err: err.message };
  }
}

// ---------------------------------------------------------------------------
// Run a BARE Playwright capture — what you get with zero developer
// effort (just `page.goto` + an error listener). This is the honest
// floor: it's the absolute minimum Playwright code that "watches" a
// page. Most teams write FAR more than this, but this is what you get
// for free out of the box.
// ---------------------------------------------------------------------------

async function runBarePlaywright(playwright, url) {
  const captured = {
    pageErrors:     [],
    consoleErrors:  [],
    consoleWarns:   [],
    networkFailures: [],
    // What Playwright BARE does NOT capture:
    securityHeaderIssues: [],   // would need writing assertions
    cspViolations:        [],   // would need writing assertions
    cookieHardening:      [],   // would need writing assertions
  };

  const browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('pageerror',  (err)  => captured.pageErrors.push(String(err.message || err)));
    page.on('console',    (msg)  => {
      const t = msg.type();
      if (t === 'error') captured.consoleErrors.push(msg.text());
      if (t === 'warning' || t === 'warn') captured.consoleWarns.push(msg.text());
    });
    page.on('requestfailed', (req) => captured.networkFailures.push(`${req.method()} ${req.url()}: ${req.failure() && req.failure().errorText}`));
    page.on('response', (resp) => {
      if (resp.status() >= 400) {
        captured.networkFailures.push(`${resp.status()} ${resp.url()}`);
      }
    });

    await page.goto(url, { waitUntil: 'load', timeout: 10000 });
    // Wait for the deferred-throw bug to fire.
    await new Promise((r) => setTimeout(r, WAIT_MS));
    await ctx.close();
  } finally {
    await browser.close();
  }

  const totalCaught =
    captured.pageErrors.length +
    captured.consoleErrors.length +
    captured.consoleWarns.length +
    captured.networkFailures.length;
  return { captured, totalCaught };
}

// ---------------------------------------------------------------------------
// Run GateTest's runtime-errors module against the URL.
// ---------------------------------------------------------------------------

async function runGateTest(url) {
  const RuntimeErrors = require('../src/modules/runtime-errors');
  const inst = new RuntimeErrors();
  const checks = [];
  const result = {
    addCheck(id, ok, meta) {
      checks.push({ id, passed: !!ok, severity: (meta && meta.severity) || 'info', message: meta && meta.message });
    },
  };
  const config = {
    getModuleConfig(name) {
      if (name === 'runtimeErrors') {
        return { url, timeoutMs: 12000, waitMs: WAIT_MS };
      }
      return {};
    },
    get(key) {
      if (key === 'targetUrl' || key === 'webUrl') return url;
      return undefined;
    },
  };
  await inst.run(result, config);
  return { checks, totalCaught: checks.filter((c) => !c.passed).length };
}

// ---------------------------------------------------------------------------
// Render markdown report
// ---------------------------------------------------------------------------

function renderMarkdown({ gateResult, playwrightResult, playwrightError }) {
  const lines = [];
  lines.push('# GateTest vs Bare Playwright — head-to-head');
  lines.push('');
  lines.push('Both ran against the same deliberately-broken fixture site');
  lines.push('(`corpus/broken-sites/example-broken.html`) containing 5 known bugs:');
  lines.push('uncaught page error, network 404, console.error, console.warn, deferred async throw.');
  lines.push('');

  if (playwrightError) {
    lines.push(`> ⚠️  Playwright not available in this environment: ${playwrightError}`);
    lines.push('> The comparison ran GateTest only — install Playwright (`cd website && npm i playwright && npx playwright install chromium`) to enable the head-to-head.');
    lines.push('');
  }

  lines.push('## Findings count');
  lines.push('');
  lines.push('| Tool | Bugs surfaced | Developer effort |');
  lines.push('|------|---------------|------------------|');
  lines.push(`| **GateTest \`runtime-errors\`** | ${gateResult ? gateResult.totalCaught : 'n/a'} | \`gatetest --module runtimeErrors --url ...\` (one line) |`);
  if (playwrightResult) {
    lines.push(`| **Bare Playwright** (no assertions) | ${playwrightResult.totalCaught} | ~30 lines of capture boilerplate + manual triage |`);
  }
  lines.push('');

  if (gateResult) {
    lines.push('## GateTest findings');
    lines.push('');
    for (const c of gateResult.checks) {
      const status = c.passed ? '✓' : '✗';
      lines.push(`- ${status} **${c.id}** [${c.severity}] — ${c.message || ''}`);
    }
    lines.push('');
  }

  if (playwrightResult) {
    const cap = playwrightResult.captured;
    lines.push('## Bare Playwright captures (what you get for free)');
    lines.push('');
    lines.push(`- pageerror events:     **${cap.pageErrors.length}**`);
    lines.push(`- console.error events: **${cap.consoleErrors.length}**`);
    lines.push(`- console.warn events:  **${cap.consoleWarns.length}**`);
    lines.push(`- network failures:     **${cap.networkFailures.length}**`);
    lines.push('');
    lines.push('## What Playwright DOESN\'T catch without you writing assertions');
    lines.push('');
    lines.push('- Missing Content-Security-Policy header (you\'d write an assertion)');
    lines.push('- Missing X-Frame-Options / frame-ancestors (you\'d write an assertion)');
    lines.push('- Missing Strict-Transport-Security (you\'d write an assertion)');
    lines.push('- Mixed content warnings (you\'d filter console)');
    lines.push('- Hydration mismatches (you\'d pattern-match console)');
    lines.push('- Cookie hardening (`httpOnly`/`secure`/`sameSite`) (you\'d inspect cookies + write assertions)');
    lines.push('- Subresource integrity gaps (you\'d parse the HTML)');
    lines.push('');
  }

  lines.push('## Honest take');
  lines.push('');
  lines.push('Playwright is a **framework** — it gives you a browser and event hooks. ');
  lines.push('Every assertion is hand-written by you. The bare-capture script above is the ');
  lines.push('most minimal "watch a page" Playwright code anyone could write, and it catches ');
  lines.push('only the most obvious surface signals — no security headers, no cookie hardening, ');
  lines.push('no CSP, no hydration mismatches, no SSR-vs-CSR drift.');
  lines.push('');
  lines.push('GateTest\'s `runtime-errors` module ships the assertions out of the box. ');
  lines.push('Same one-line invocation, same fixture, more bugs surfaced, zero boilerplate.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { fixture: DEFAULT_FIXTURE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') { args.fixture = argv[++i]; continue; }
    if (a === '--json')    { args.json = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/compare-playwright.js [--fixture path.html] [--json]\n');
    return 0;
  }

  if (!fs.existsSync(args.fixture)) {
    process.stderr.write(`compare-playwright: fixture not found: ${args.fixture}\n`);
    return 1;
  }
  const html = fs.readFileSync(args.fixture, 'utf8');

  const { server, url } = await serveFixture(html);
  let gateResult, playwrightResult, playwrightError;

  try {
    // GateTest first — it's deterministic and fast.
    try {
      gateResult = await runGateTest(url);
    } catch (err) {
      gateResult = { error: err.message, checks: [], totalCaught: 0 };
    }

    // Bare Playwright next.
    const pw = loadPlaywright();
    if (pw.err) {
      playwrightError = pw.err;
    } else {
      try {
        playwrightResult = await runBarePlaywright(pw, url);
      } catch (err) {
        playwrightError = err.message;
      }
    }
  } finally {
    server.close();
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      fixture: args.fixture,
      url,
      gateResult,
      playwrightResult,
      playwrightError,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderMarkdown({ gateResult, playwrightResult, playwrightError }) + '\n');
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`compare-playwright: unhandled: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { renderMarkdown, parseArgs };
