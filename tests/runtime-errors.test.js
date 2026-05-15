'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RuntimeErrorsModule = require('../src/modules/runtime-errors.js');

test('module exports a class with the expected name', () => {
  const m = new RuntimeErrorsModule();
  assert.equal(m.name, 'runtimeErrors');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new RuntimeErrorsModule();
  const checks = [];
  const result = {
    addCheck: (name, passed, details) => checks.push({ name, passed, details }),
  };
  const config = {
    getModuleConfig: () => ({}),
    get: () => undefined,
  };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'runtime-errors:config');
  assert.equal(checks[0].passed, true);
});

test('run() falls back gracefully when playwright is not installed', async () => {
  // Intercept require for the duration of this test
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'playwright') {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalResolve.call(this, request, parent, ...rest);
  };

  try {
    const m = new RuntimeErrorsModule();
    const checks = [];
    const result = {
      addCheck: (name, passed, details) => checks.push({ name, passed, details }),
    };
    const config = {
      getModuleConfig: () => ({ url: 'https://example.com' }),
      get: () => undefined,
    };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'runtime-errors:playwright-missing');
    assert.equal(checks[0].details.severity, 'info');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module file does not import playwright at the top level', () => {
  // The module must only require playwright INSIDE run() so that
  // loading the module file in environments without playwright doesn't
  // throw at registry init time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'runtime-errors.js'), 'utf-8');
  // Quick smoke check — playwright should appear in source but not at
  // an unconditional top-level require.
  assert.ok(src.includes('playwright'), 'module should reference playwright');
  // Detect top-level imports of playwright (no leading whitespace).
  const topLevelImports = src
    .split('\n')
    .filter((line) => /^\s*(const|let|var)\s+.*=\s*require\(['"]playwright['"]\)/.test(line));
  assert.equal(topLevelImports.length, 0, 'playwright must only be required inside run() with a try/catch');
});

test('module registers in the built-in modules map by name "runtimeErrors"', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES, 'BUILT_IN_MODULES must be exported');
  assert.ok(registry.BUILT_IN_MODULES.runtimeErrors, 'runtimeErrors must be in BUILT_IN_MODULES');
});

test('module is included in the "web" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const web = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.web;
  assert.ok(Array.isArray(web), 'web suite must be defined');
  assert.ok(web.includes('runtimeErrors'), 'runtimeErrors must be in the web suite');
});

test('module is included in the "wp" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const wp = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.wp;
  assert.ok(Array.isArray(wp), 'wp suite must be defined');
  assert.ok(wp.includes('runtimeErrors'), 'runtimeErrors must be in the wp suite');
});

// Smoke test: ensure the module can be instantiated alongside the rest
// of the engine without throwing.
test('module instantiates without errors', () => {
  // Just confirm we can construct the module.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-errors-test-'));
  try {
    const m = new RuntimeErrorsModule();
    assert.ok(m);
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
