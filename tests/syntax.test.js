const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SyntaxModule = require('../src/modules/syntax');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('SyntaxModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-syntax-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new SyntaxModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new SyntaxModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

describe('SyntaxModule — fast-mode tsc skip', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-syntax-fast-'));
    // Plant a real tsconfig.json so the tsc step would otherwise fire.
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs', jsx: 'preserve' },
    }));
    fs.writeFileSync(path.join(tmp, 'index.ts'), 'export const x: string = "hi";\n');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('GATETEST_FAST=1 skips tsc and emits an info-level "deferred to CI" check', async () => {
    const prev = process.env.GATETEST_FAST;
    process.env.GATETEST_FAST = '1';
    try {
      const mod = new SyntaxModule();
      const result = makeResult();
      const t0 = Date.now();
      await mod.run(result, { projectRoot: tmp });
      const elapsed = Date.now() - t0;

      // Must be fast — well under the 60s tsc per-dir timeout.
      assert.ok(elapsed < 5000, `Fast mode took ${elapsed}ms — should be ≪ 5s`);

      // Must surface the skip explicitly (not silent).
      const tsCheck = result.checks.find((c) => c.name === 'typescript-strict');
      assert.ok(tsCheck, 'typescript-strict check must exist');
      assert.strictEqual(tsCheck.passed, true);
      assert.strictEqual(tsCheck.severity, 'info');
      assert.match(tsCheck.message, /skipped|deferred|GATETEST_FAST/i);
    } finally {
      if (prev === undefined) delete process.env.GATETEST_FAST;
      else process.env.GATETEST_FAST = prev;
    }
  });

  it('GATETEST_SKIP_TSC=1 also triggers the same skip', async () => {
    const prev = process.env.GATETEST_SKIP_TSC;
    process.env.GATETEST_SKIP_TSC = '1';
    try {
      const mod = new SyntaxModule();
      const result = makeResult();
      await mod.run(result, { projectRoot: tmp });
      const tsCheck = result.checks.find((c) => c.name === 'typescript-strict');
      assert.ok(tsCheck);
      assert.strictEqual(tsCheck.passed, true);
      assert.strictEqual(tsCheck.severity, 'info');
    } finally {
      if (prev === undefined) delete process.env.GATETEST_SKIP_TSC;
      else process.env.GATETEST_SKIP_TSC = prev;
    }
  });
});
