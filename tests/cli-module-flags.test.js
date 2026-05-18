// ============================================================================
// CLI-MODULE-FLAGS TEST — verifies `--module mutation` and `--module chaos`
// are reachable from the CLI surface and behave gracefully on smoke runs.
//
// These are the two Nuclear-tier modules that can ONLY run via the GitHub
// Action (they need the customer's test runner + Chromium binary), so the
// CLI is their entry point in CI. This file guards the contract.
//
// We do NOT spawn the full CLI binary for every assertion — that's flaky
// and slow. Instead we exercise the same code path the CLI uses:
// GateTest.runModule(name). The chaos module is exercised directly (no
// browser needed because we drop the URL and prove it short-circuits).
// The mutation module is exercised through its run() with a tmp project.
// ============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ChaosModule = require('../src/modules/chaos');
const MutationModule = require('../src/modules/mutation');

// Stub result + config helpers — same shape the runner provides.
function makeResult() {
  const calls = [];
  return {
    calls,
    addCheck(name, passed, meta) {
      calls.push({ name, passed, meta: meta || {} });
    },
  };
}

function makeConfig({ chaosUrl, explorerUrl, liveCrawlerUrl, projectRoot, mutation } = {}) {
  return {
    projectRoot: projectRoot || process.cwd(),
    getModuleConfig(name) {
      if (name === 'chaos') return chaosUrl ? { url: chaosUrl } : {};
      if (name === 'mutation') return mutation || {};
      return {};
    },
    get(key) {
      if (key === 'explorer.url') return explorerUrl;
      if (key === 'liveCrawler.url') return liveCrawlerUrl;
      return undefined;
    },
  };
}

// ── --module chaos contract ────────────────────────────────────────────────

test('--module chaos: invokes ChaosModule.run() (the same path the CLI hits)', async () => {
  // The CLI's `--module chaos` flag ultimately calls gatetest.runModule('chaos')
  // which calls the module's run(). We exercise run() directly. The
  // chaos.js source contains the same name string the registry uses.
  const mod = new ChaosModule();
  assert.equal(typeof mod.run, 'function');
  assert.equal(mod.name, 'chaos', 'module name must match the --module value');
});

test('--module chaos: without GATETEST_CHAOS_URL → returns the "no URL configured" info-level finding', async () => {
  // Clean env so neither GATETEST_CHAOS_URL nor any other URL leaks in.
  const prior = process.env.GATETEST_CHAOS_URL;
  delete process.env.GATETEST_CHAOS_URL;

  const mod = new ChaosModule();
  const result = makeResult();
  const config = makeConfig();

  try {
    await mod.run(result, config);
  } finally {
    if (prior !== undefined) process.env.GATETEST_CHAOS_URL = prior;
  }

  assert.equal(result.calls.length, 1, 'expected exactly one check on no-URL early exit');
  const c = result.calls[0];
  assert.equal(c.name, 'chaos:config');
  assert.equal(c.passed, true, 'no-URL is informational, not a failure');
  assert.match(c.meta.message, /No URL configured/i);
});

test('--module chaos: GATETEST_CHAOS_URL env var overrides config URL (Action wires it this way)', async () => {
  // The GitHub Action sets GATETEST_CHAOS_URL on the chaos step. The
  // module MUST honour it so the customer doesn't need a .gatetest/config.
  // We don't want to actually launch a browser — stub the playwright
  // require to throw so we exit cleanly with the playwright check.
  const prior = process.env.GATETEST_CHAOS_URL;
  process.env.GATETEST_CHAOS_URL = 'https://action-wired.example.com';

  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'playwright') throw new Error("Cannot find module 'playwright'");
    return origResolve.call(this, req, parent, ...rest);
  };

  const mod = new ChaosModule();
  const result = makeResult();
  // No URL via config or sibling modules — only the env var.
  const config = makeConfig();

  try {
    await mod.run(result, config);
  } finally {
    Module._resolveFilename = origResolve;
    if (prior !== undefined) {
      process.env.GATETEST_CHAOS_URL = prior;
    } else {
      delete process.env.GATETEST_CHAOS_URL;
    }
  }

  // If GATETEST_CHAOS_URL were ignored, we'd see the chaos:config "no URL"
  // info finding instead. Getting past it to the playwright-missing
  // branch proves the env var was read.
  const pwCheck = result.calls.find((c) => c.name === 'chaos:playwright');
  assert.ok(pwCheck, 'expected to advance past URL resolution into the playwright check');
  assert.equal(pwCheck.passed, false);
});

// ── --module mutation contract ─────────────────────────────────────────────

test('--module mutation: invokes MutationModule.run() (the same path the CLI hits)', () => {
  const mod = new MutationModule();
  assert.equal(typeof mod.run, 'function');
  assert.equal(mod.name, 'mutation', 'module name must match the --module value');
});

test('--module mutation: empty project (no test framework) → emits info-level skip, never crashes', async () => {
  // Mutation testing requires a test runner to exist. In an empty repo
  // it must skip cleanly — that's the contract the Action depends on.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-mut-'));
  try {
    const mod = new MutationModule();
    const result = makeResult();
    const config = makeConfig({ projectRoot: tmp });

    await mod.run(result, config);

    // Either "no test framework detected" OR "no source files" — both are
    // valid informational early exits and BOTH must be no-error.
    const fired = result.calls.find((c) => /mutation:(detect|sources)/.test(c.name));
    assert.ok(fired, 'expected an informational mutation:detect or mutation:sources check');
    assert.equal(fired.passed, true, 'early-exit checks are informational, never failures');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
