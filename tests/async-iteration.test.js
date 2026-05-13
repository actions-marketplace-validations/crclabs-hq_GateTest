const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AsyncIterationModule = require('../src/modules/async-iteration');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new AsyncIterationModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('AsyncIterationModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'async-iteration:no-files'));
  });

  it('scans JS/TS sources', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'async-iteration:scanning'));
  });
});

describe('AsyncIterationModule — async reducer', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-red-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on arr.reduce(async (acc, x) => ...)', async () => {
    write(tmp, 'src/a.ts', [
      'export async function sum(arr) {',
      '  return arr.reduce(async (acc, x) => {',
      '    const prev = await acc;',
      '    return prev + x;',
      '  }, 0);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-reduce:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on arr.reduceRight(async ...)', async () => {
    write(tmp, 'src/a.ts', 'const r = arr.reduceRight(async (acc, x) => x, 0);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-reduce:')));
  });

  it('errors on arr.reduce(async function (acc, x) {...})', async () => {
    write(tmp, 'src/a.ts', 'const r = arr.reduce(async function (acc, x) { return acc; }, []);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-reduce:')));
  });

  it('downgrades to warning in test files', async () => {
    write(tmp, 'src/a.test.ts', 'arr.reduce(async (a, x) => a, 0);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-reduce:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT flag sync reduce', async () => {
    write(tmp, 'src/a.ts', 'const total = arr.reduce((acc, x) => acc + x, 0);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('AsyncIterationModule — async predicate', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-pred-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on arr.filter(async x => ...)', async () => {
    write(tmp, 'src/a.ts', 'const allowed = arr.filter(async (x) => await check(x));\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-predicate:'));
    assert.ok(hit);
    assert.strictEqual(hit.method, 'filter');
  });

  it('errors on arr.some(async ...)', async () => {
    write(tmp, 'src/a.ts', 'const any = arr.some(async (x) => await check(x));\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-predicate:') && c.method === 'some'));
  });

  it('errors on arr.every(async ...)', async () => {
    write(tmp, 'src/a.ts', 'const all = arr.every(async (x) => await check(x));\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-predicate:') && c.method === 'every'));
  });

  it('errors on arr.find(async ...)', async () => {
    write(tmp, 'src/a.ts', 'const hit = arr.find(async (x) => await check(x));\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-predicate:') && c.method === 'find'));
  });

  it('does NOT flag sync filter', async () => {
    write(tmp, 'src/a.ts', 'const ok = arr.filter((x) => x > 0);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('AsyncIterationModule — async forEach', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-fe-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on arr.forEach(async ...)', async () => {
    write(tmp, 'src/a.ts', 'arr.forEach(async (x) => { await save(x); });\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('async-iteration:async-foreach:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT flag sync forEach', async () => {
    write(tmp, 'src/a.ts', 'arr.forEach((x) => console.log(x));\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('AsyncIterationModule — unwrapped map', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-map-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on bare arr.map(async ...)', async () => {
    write(tmp, 'src/a.ts', 'const out = arr.map(async (x) => await fetch(x));\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('async-iteration:unwrapped-map:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT flag arr.map inside Promise.all(...)', async () => {
    write(tmp, 'src/a.ts', 'const out = await Promise.all(arr.map(async (x) => await fetch(x)));\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag arr.map inside Promise.allSettled(...)', async () => {
    write(tmp, 'src/a.ts', 'const out = await Promise.allSettled(arr.map(async (x) => fetch(x)));\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag arr.map().then(...)', async () => {
    write(tmp, 'src/a.ts', 'arr.map(async (x) => fetch(x)).then((r) => console.log(r));\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('warns on arr.flatMap(async ...) bare', async () => {
    write(tmp, 'src/a.ts', 'const out = arr.flatMap(async (x) => [x, x]);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('async-iteration:unwrapped-map:')));
  });
});

describe('AsyncIterationModule — suppressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-supp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips string-context hits', async () => {
    write(tmp, 'src/a.ts', 'const doc = "arr.reduce(async (a, x) => ...)";\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('skips block-comment hits', async () => {
    write(tmp, 'src/a.ts', [
      '/**',
      ' * Example: arr.reduce(async (a, x) => x, 0)',
      ' */',
      'export const y = 1;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('respects async-iteration-ok marker on same line', async () => {
    write(tmp, 'src/a.ts', 'arr.forEach(async (x) => await log(x)); // async-iteration-ok\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('respects async-iteration-ok marker on preceding line', async () => {
    write(tmp, 'src/a.ts', [
      '// async-iteration-ok',
      'arr.forEach(async (x) => await log(x));',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('async-iteration:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('AsyncIterationModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ai-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'async-iteration:summary');
    assert.ok(s);
    assert.match(s.message, /file\(s\).*issue\(s\)/);
  });
});
