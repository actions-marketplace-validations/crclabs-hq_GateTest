const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FlakyTestsModule = require('../src/modules/flaky-tests');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new FlakyTestsModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('FlakyTestsModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no test files exist', async () => {
    write(tmp, 'src/a.js', 'console.log("hi");\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:no-files'));
  });

  it('discovers *.test.js files', async () => {
    write(tmp, 'src/a.test.js', 'it("x", () => {});\n');
    const r = await run(tmp);
    const scan = r.checks.find((c) => c.name === 'flaky-tests:scanning');
    assert.ok(scan);
    assert.match(scan.message, /1 test file/);
  });

  it('discovers *.spec.ts files', async () => {
    write(tmp, 'src/a.spec.ts', 'it("x", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:scanning'));
  });

  it('discovers files under tests/ directory', async () => {
    write(tmp, 'tests/something.js', 'it("x", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:scanning'));
  });
});

describe('FlakyTestsModule — focus/skip modifiers', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-mod-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on it.only', async () => {
    write(tmp, 'a.test.js', 'it.only("x", () => { expect(1).toBe(1); });\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:only-committed:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on fdescribe', async () => {
    write(tmp, 'a.test.js', 'fdescribe("group", () => { it("x", () => {}); });\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:only-committed:')));
  });

  it('warns on it.skip', async () => {
    write(tmp, 'a.test.js', 'it.skip("x", () => {});\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:skip-committed:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on xit', async () => {
    write(tmp, 'a.test.js', 'xit("x", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:skip-committed:')));
  });

  it('emits info on .todo with no linked issue', async () => {
    write(tmp, 'a.test.js', 'it.todo("handles negative zero");\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:todo-no-issue:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('does NOT flag `.skip` / `.only` embedded in string fixtures', async () => {
    // Regression: fake-fix-detector-style fixtures contain diff lines
    // like `"+  it.skip('rejects invalid tokens', () => {"` — those are
    // string literals, not real test code.
    write(tmp, 'a.test.js', [
      'const fixture = [',
      '  "--- a/tests/auth.test.js",',
      '  "+++ b/tests/auth.test.js",',
      "  \"+  it.skip(\'rejects invalid tokens\', () => {\",",
      "  \"+  it.only(\'debug\', () => {\",",
      '].join("\\n");',
      'it("checks the fixture", () => { expect(fixture).toBeDefined(); });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:skip-committed:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:only-committed:')),
      undefined,
    );
  });

  it('does NOT flag .todo with issue link', async () => {
    write(tmp, 'a.test.js', 'it.todo("handles negative zero — see #456");\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:todo-no-issue:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — nondeterminism', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-nd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on Math.random() in test', async () => {
    write(tmp, 'a.test.js', [
      'it("picks a number", () => {',
      '  const n = Math.random();',
      '  expect(n).toBeGreaterThan(0);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:math-random:')));
  });

  it('warns on Date.now() without fake timers', async () => {
    write(tmp, 'a.test.js', [
      'it("is recent", () => {',
      '  const t = Date.now();',
      '  expect(t).toBeGreaterThan(0);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-clock:')));
  });

  it('does NOT warn on Date.now() when jest.useFakeTimers is set', async () => {
    write(tmp, 'a.test.js', [
      'beforeEach(() => { jest.useFakeTimers(); });',
      'it("is recent", () => {',
      '  const t = Date.now();',
      '  expect(t).toBeGreaterThan(0);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:real-clock:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — real network', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-net-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on fetch() with real URL and no mock', async () => {
    write(tmp, 'a.test.js', [
      'it("hits api", async () => {',
      '  const r = await fetch("https://api.example.com/x");',
      '  expect(r.ok).toBe(true);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')));
  });

  it('does NOT warn on fetch() when nock is used', async () => {
    write(tmp, 'a.test.js', [
      'const nock = require("nock");',
      'nock("https://api.example.com").get("/x").reply(200, { ok: true });',
      'it("hits api", async () => {',
      '  const r = await fetch("https://api.example.com/x");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')),
      undefined,
    );
  });

  it('warns on axios.get with real URL and no mock', async () => {
    write(tmp, 'a.test.js', [
      'const axios = require("axios");',
      'it("gets", async () => {',
      '  await axios.get("https://api.stripe.com/v1/charges");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')));
  });
});

describe('FlakyTestsModule — real timers', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-tim-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on setTimeout without fake timers', async () => {
    write(tmp, 'a.test.js', [
      'it("delays", (done) => {',
      '  setTimeout(() => done(), 100);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-timer:')));
  });

  it('does NOT warn on setTimeout when vi.useFakeTimers is set', async () => {
    write(tmp, 'a.test.js', [
      'beforeEach(() => { vi.useFakeTimers(); });',
      'it("delays", () => {',
      '  setTimeout(() => {}, 100);',
      '  vi.advanceTimersByTime(100);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:real-timer:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — process.env leaks', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-env-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on process.env mutation with no restore', async () => {
    write(tmp, 'a.test.js', [
      'it("uses env", () => {',
      '  process.env.STRIPE_KEY = "sk_test_123";',
      '  expect(process.env.STRIPE_KEY).toBe("sk_test_123");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:env-leak:'));
    assert.ok(hit);
    assert.strictEqual(hit.envVar, 'STRIPE_KEY');
  });

  it('does NOT warn when afterEach restores the env', async () => {
    write(tmp, 'a.test.js', [
      'const orig = process.env.STRIPE_KEY;',
      'afterEach(() => { process.env.STRIPE_KEY = orig; });',
      'it("uses env", () => {',
      '  process.env.STRIPE_KEY = "sk_test_123";',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:env-leak:')),
      undefined,
    );
  });

  it('does NOT warn when afterEach deletes the env var', async () => {
    write(tmp, 'a.test.js', [
      'afterEach(() => { delete process.env.STRIPE_KEY; });',
      'it("uses env", () => {',
      '  process.env.STRIPE_KEY = "sk_test_123";',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:env-leak:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — self-admitted flakes', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-admit-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on test title containing "flaky"', async () => {
    write(tmp, 'a.test.js', 'it("is sometimes flaky in CI", () => {});\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:'));
    assert.ok(hit);
  });

  it('warns on test title containing "intermittent"', async () => {
    write(tmp, 'a.test.js', 'it("intermittent failure on Windows", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:')));
  });

  it('does NOT warn on a normal title', async () => {
    write(tmp, 'a.test.js', 'it("parses a valid JSON payload", () => {});\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a well-written test', async () => {
    write(tmp, 'a.test.js', [
      'const { describe, it } = require("node:test");',
      'const assert = require("node:assert");',
      'describe("math", () => {',
      '  it("adds two numbers", () => {',
      '    assert.strictEqual(1 + 2, 3);',
      '  });',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `unexpected findings: ${JSON.stringify(issues, null, 2)}`);
  });

  it('records a summary', async () => {
    write(tmp, 'a.test.js', 'it("x", () => {});\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'flaky-tests:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});
