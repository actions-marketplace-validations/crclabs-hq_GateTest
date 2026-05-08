// ============================================================================
// CHAOS-MODULE TEST — rewritten for the zero-dep static-analysis implementation
// ============================================================================
// Covers src/modules/chaos.js — Playwright removed. Module now walks source
// files looking for error-boundary, timeout, retry, offline, and degradation
// patterns. HTTP probe optional (URL-gated). All 5 scenario methods preserved
// for backward compat.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ChaosModule = require('../src/modules/chaos');

// Minimal stub of the result object
function makeResult() {
  const calls = [];
  return {
    calls,
    addCheck(name, passed, meta) {
      calls.push({ name, passed, meta: meta || {} });
    },
  };
}

// Minimal config stub
function makeConfig({ chaosUrl, explorerUrl, liveCrawlerUrl, projectRoot } = {}) {
  return {
    getModuleConfig(name) {
      if (name === 'chaos') return chaosUrl ? { url: chaosUrl } : {};
      return {};
    },
    get(key) {
      if (key === 'explorer.url') return explorerUrl;
      if (key === 'liveCrawler.url') return liveCrawlerUrl;
      if (key === 'projectRoot') return projectRoot;
      return undefined;
    },
  };
}

// Create a temp directory with source files for testing
function makeTmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-chaos-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ---------- Module shape ----------

test('ChaosModule — module shape', () => {
  const mod = new ChaosModule();
  assert.equal(mod.name, 'chaos');
  assert.equal(typeof mod.description, 'string');
  assert.ok(mod.description.length > 0);
  assert.equal(typeof mod.run, 'function');
});

test('ChaosModule — legacy scenario methods still exist (backward compat)', () => {
  const mod = new ChaosModule();
  assert.equal(typeof mod._testSlowNetwork, 'function');
  assert.equal(typeof mod._testApiFailures, 'function');
  assert.equal(typeof mod._testOfflineMode, 'function');
  assert.equal(typeof mod._testMissingResources, 'function');
  assert.equal(typeof mod._testTimeouts, 'function');
  assert.equal(typeof mod._testErrorBoundaries, 'function');
  assert.equal(typeof mod._testTimeoutHygiene, 'function');
  assert.equal(typeof mod._testRetryLogic, 'function');
  assert.equal(typeof mod._testOfflineCapability, 'function');
  assert.equal(typeof mod._testGracefulDegradation, 'function');
});

// ---------- run() on empty project ----------

test('run — empty project dir records source-skip check only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-chaos-empty-'));
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    const config = makeConfig({ projectRoot: dir });
    await mod.run(result, config);
    const sourceCheck = result.calls.find((c) => c.name === 'chaos:source');
    assert.ok(sourceCheck, 'expected chaos:source check');
    assert.equal(sourceCheck.passed, true);
    assert.match(sourceCheck.meta.message, /No source files found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Error-boundary detection ----------

test('_testErrorBoundaries — passes when try/catch is widespread', async () => {
  const dir = makeTmpProject({
    'a.js': 'try { doThing(); } catch(e) { handleError(e); }',
    'b.js': 'try { fetch() } catch(e) {}', // error-ok — test fixture string
    'c.ts': 'promise.catch(err => log(err));',
    'd.ts': 'class Foo extends ErrorBoundary {}',
    'e.js': 'try { x() } catch {}', // error-ok — test fixture string
    'f.js': 'try { y() } catch {}', // error-ok — test fixture string
  });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testErrorBoundaries(
      ['a.js','b.js','c.ts','d.ts','e.js','f.js'].map(f => path.join(dir, f)),
      result
    );
    const check = result.calls.find((c) => c.name === 'chaos:error-boundaries');
    assert.ok(check);
    assert.equal(check.passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_testErrorBoundaries — warns when fewer than 5% of files have error handling', async () => {
  // 1 file has try/catch but 30 files have none → ratio 1/31 ≈ 3%
  const files = {};
  for (let i = 0; i < 30; i++) files[`plain${i}.js`] = `const x = ${i};`;
  files['withTry.js'] = 'try { doThing(); } catch(e) {}'; // error-ok — test fixture string
  const dir = makeTmpProject(files);
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    const allFiles = Object.keys(files).map(f => path.join(dir, f));
    await mod._testErrorBoundaries(allFiles, result);
    const check = result.calls.find((c) => c.name === 'chaos:error-boundaries');
    assert.ok(check);
    assert.equal(check.passed, false);
    assert.match(check.meta.message, /Very few error boundaries/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Timeout detection ----------

test('_testTimeoutHygiene — passes when AbortController present', async () => {
  const dir = makeTmpProject({ 'api.js': 'const ctrl = new AbortController(); fetch(url, { signal: ctrl.signal });' });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testTimeoutHygiene([path.join(dir, 'api.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:timeouts');
    assert.ok(check);
    assert.equal(check.passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_testTimeoutHygiene — warns when no timeout patterns found', async () => {
  const dir = makeTmpProject({ 'api.js': 'fetch(url);' });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testTimeoutHygiene([path.join(dir, 'api.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:timeouts');
    assert.ok(check);
    assert.equal(check.passed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Retry detection ----------

test('_testRetryLogic — passes (info) when no retry found', async () => {
  const dir = makeTmpProject({ 'simple.js': 'const x = 1;' });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testRetryLogic([path.join(dir, 'simple.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:retry');
    assert.ok(check);
    assert.equal(check.passed, true); // info-level pass
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_testRetryLogic — passes when p-retry pattern found', async () => {
  const dir = makeTmpProject({ 'api.js': "const retry = require('p-retry');" });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testRetryLogic([path.join(dir, 'api.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:retry');
    assert.ok(check);
    assert.equal(check.passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Offline capability ----------

test('_testOfflineCapability — info pass when no service worker', async () => {
  const dir = makeTmpProject({ 'app.js': 'console.log("hello");' });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testOfflineCapability([path.join(dir, 'app.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:offline');
    assert.ok(check);
    assert.equal(check.passed, true);
    assert.match(check.meta.message, /informational/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_testOfflineCapability — passes when serviceWorker detected', async () => {
  const dir = makeTmpProject({ 'sw.js': "self.addEventListener('install', e => {});" });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testOfflineCapability([path.join(dir, 'sw.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:offline');
    assert.ok(check);
    assert.equal(check.passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Graceful degradation ----------

test('_testGracefulDegradation — info when no loading state patterns', async () => {
  const dir = makeTmpProject({ 'page.js': 'const x = 1;' });
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testGracefulDegradation([path.join(dir, 'page.js')], result);
    const check = result.calls.find((c) => c.name === 'chaos:degradation');
    assert.ok(check);
    // can be pass or fail at info level — just check the key exists
    assert.ok(typeof check.passed === 'boolean');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_testGracefulDegradation — passes when Suspense + isLoading present', async () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`comp${i}.tsx`] = `<Suspense fallback={<Skeleton />}><Component /></Suspense>`;
  const dir = makeTmpProject(files);
  try {
    const mod = new ChaosModule();
    const result = makeResult();
    await mod._testGracefulDegradation(Object.keys(files).map(f => path.join(dir, f)), result);
    const check = result.calls.find((c) => c.name === 'chaos:degradation');
    assert.ok(check);
    assert.equal(check.passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Legacy method stubs ----------

test('_testApiFailures stub records a pass check', async () => {
  const mod = new ChaosModule();
  const result = makeResult();
  await mod._testApiFailures(null, null, result);
  const check = result.calls.find((c) => c.name === 'chaos:api-failures');
  assert.ok(check);
  assert.equal(check.passed, true);
});

test('_testOfflineMode stub records a pass check', async () => {
  const mod = new ChaosModule();
  const result = makeResult();
  await mod._testOfflineMode(null, null, result);
  const check = result.calls.find((c) => c.name === 'chaos:offline-mode');
  assert.ok(check);
  assert.equal(check.passed, true);
});

test('_testMissingResources stub records a pass check', async () => {
  const mod = new ChaosModule();
  const result = makeResult();
  await mod._testMissingResources(null, null, result);
  const check = result.calls.find((c) => c.name === 'chaos:missing-resources');
  assert.ok(check);
  assert.equal(check.passed, true);
});

// ---------- Module is registerable ----------

test('ChaosModule — constructable with no args', () => {
  const mod = new ChaosModule();
  assert.ok(mod instanceof ChaosModule);
  assert.equal(mod.name, 'chaos');
});
