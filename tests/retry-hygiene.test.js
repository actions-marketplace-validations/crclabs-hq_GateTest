const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RetryHygieneModule = require('../src/modules/retry-hygiene');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new RetryHygieneModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('RetryHygieneModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no source files exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'retry-hygiene:no-files'));
  });

  it('scans JS/TS sources', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'retry-hygiene:scanning'));
  });
});

describe('RetryHygieneModule — unbounded loop', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-ub-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on while(true) with fetch and no break', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  while (true) {',
      '    const res = await fetch("https://x.com/api");',
      '    if (res.ok) return res;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // `if (res.ok) return res` is technically a break-shape but we only
    // look for `break` / max-attempts markers. The test locks in
    // current conservative behaviour: flag this as unbounded.
    const hit = r.checks.find((c) => c.name.startsWith('retry-hygiene:unbounded-loop:'));
    assert.ok(hit, `expected unbounded-loop hit, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on for(;;) with axios and no break', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  for (;;) {',
      '    const res = await axios.get("/x");',
      '    console.log(res.data);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('retry-hygiene:unbounded-loop:')));
  });

  it('does NOT flag while(true) with explicit break', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  let attempts = 0;',
      '  while (true) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) break;',
      '    attempts += 1;',
      '    if (attempts >= 5) break;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:unbounded-loop:')),
      undefined,
    );
  });
});

describe('RetryHygieneModule — no backoff / no jitter', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-nb-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on constant sleep in a retry loop (no backoff, no jitter)', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) return res;',
      '    await sleep(1000);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const noBackoff = r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:'));
    const noJitter = r.checks.find((c) => c.name.startsWith('retry-hygiene:no-jitter:'));
    assert.ok(noBackoff, `expected no-backoff, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
    assert.strictEqual(noBackoff.severity, 'warning');
    assert.strictEqual(noBackoff.delay, 1000);
    assert.ok(noJitter);
  });

  it('does NOT warn no-backoff when multiplier uses attempt', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) return res;',
      '    await sleep(100 * 2 ** attempt);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:')),
      undefined,
    );
  });

  it('does NOT warn no-jitter when Math.random is in the window', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) return res;',
      '    const base = 100 * 2 ** attempt;',
      '    await sleep(base * (0.5 + Math.random()));',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:no-jitter:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:')),
      undefined,
    );
  });

  it('warns on setTimeout with literal ms inside a retry loop', async () => {
    write(tmp, 'src/a.js', [
      'function doRetry() {',
      '  let attempt = 0;',
      '  while (attempt < 5) {',
      '    fetch("/x").then(() => {});',
      '    setTimeout(() => {}, 500);',
      '    attempt += 1;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:')));
  });
});

describe('RetryHygieneModule — library-backed retry', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-lib-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records info when async-retry is imported at file top', async () => {
    write(tmp, 'src/a.ts', [
      'const retry = require(\'async-retry\');',
      'async function run() {',
      '  return retry(async (bail) => {',
      '    const res = await fetch("/x");',
      '    if (!res.ok) throw new Error("retry");',
      '    return res;',
      '  }, { retries: 5, factor: 2, randomize: true });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // The retry(...) call is not itself a loop, but the scanner
    // shouldn't flag anything bad here — zero issues.
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `got: ${JSON.stringify(issues)}`);
  });
});

describe('RetryHygieneModule — retry on 4xx', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-4xx-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when retry loop references 4xx status without a guard', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  let attempt = 0;',
      '  while (attempt < 5) {',
      '    const res = await fetch("/x");',
      '    if (res.status === 429) {',
      '      attempt += 1;',
      '      continue;',
      '    }',
      '    return res;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // Note: 429 is a 4xx that IS genuinely retryable; this test
    // captures the conservative "flag it, let the dev review" shape.
    const hit = r.checks.find((c) => c.name.startsWith('retry-hygiene:retry-on-4xx:'));
    assert.ok(hit, `expected retry-on-4xx hit, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
  });

  it('does NOT warn when the retry block guards 4xx via throw', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  let attempt = 0;',
      '  while (attempt < 5) {',
      '    const res = await fetch("/x");',
      '    if (res.status >= 400 && res.status < 500) throw new Error("4xx");',
      '    if (res.ok) return res;',
      '    attempt += 1;',
      '    await sleep(100 * 2 ** attempt + Math.random() * 100);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:retry-on-4xx:')),
      undefined,
    );
  });
});

describe('RetryHygieneModule — negatives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-neg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a plain for loop with no HTTP call', async () => {
    write(tmp, 'src/a.ts', [
      'function run(items) {',
      '  for (const item of items) {',
      '    console.log(item);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0);
  });

  it('does NOT flag retry text embedded in a string literal', async () => {
    write(tmp, 'src/a.ts', [
      'function docs() {',
      '  return "while (true) { await fetch(\'/x\'); }";',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0);
  });
});

describe('RetryHygieneModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a well-formed exponential-backoff-with-jitter retry', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  const MAX_ATTEMPTS = 5;',
      '  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.status >= 400 && res.status < 500) throw new Error("4xx");',
      '    if (res.ok) return res;',
      '    const base = 100 * 2 ** attempt;',
      '    await sleep(base * (0.5 + Math.random()));',
      '  }',
      '  throw new Error("max attempts");',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `got: ${JSON.stringify(issues)}`);
  });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'retry-hygiene:summary');
    assert.ok(s);
    assert.match(s.message, /1 file\(s\)/);
  });
});
