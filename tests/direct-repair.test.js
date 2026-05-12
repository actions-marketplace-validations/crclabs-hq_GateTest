'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { DirectRepair, PatternCache, patternHash, BUILTIN_PATTERNS } = require('../src/core/direct-repair');

// ─── patternHash ──────────────────────────────────────────────────────────────

describe('patternHash', () => {
  it('returns a 12-char hex string', () => {
    const h = patternHash('lint', 'console.log found in src/index.js:42');
    assert.match(h, /^[0-9a-f]{12}$/);
  });

  it('produces the same hash for the same pattern class', () => {
    const h1 = patternHash('lint', 'console.log found in src/index.js:42');
    const h2 = patternHash('lint', 'console.log found in src/other.js:99');
    assert.strictEqual(h1, h2);
  });

  it('produces different hashes for different modules', () => {
    const h1 = patternHash('lint', 'console.log found at line N');
    const h2 = patternHash('security', 'console.log found at line N');
    assert.notStrictEqual(h1, h2);
  });
});

// ─── PatternCache ─────────────────────────────────────────────────────────────

describe('PatternCache', () => {
  it('returns null on cache miss', () => {
    const c = new PatternCache();
    assert.strictEqual(c.get('lint', 'abc123'), null);
  });

  it('stores and retrieves a patch', () => {
    const c = new PatternCache();
    c.set('lint', 'abc123', 'const x = 1;');
    assert.strictEqual(c.get('lint', 'abc123'), 'const x = 1;');
  });

  it('persists to disk and reloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cache-'));
    try {
      const c1 = new PatternCache(dir);
      c1.set('lint', 'key1', 'patch content');

      const c2 = new PatternCache(dir);
      assert.strictEqual(c2.get('lint', 'key1'), 'patch content');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports size', () => {
    const c = new PatternCache();
    assert.strictEqual(c.size(), 0);
    c.set('m', 'k', 'p');
    assert.strictEqual(c.size(), 1);
  });
});

// ─── BUILTIN_PATTERNS ─────────────────────────────────────────────────────────

describe('BUILTIN_PATTERNS', () => {
  it('has at least 6 patterns', () => {
    assert.ok(BUILTIN_PATTERNS.length >= 6);
  });

  it('each pattern has match, module, apply', () => {
    for (const p of BUILTIN_PATTERNS) {
      assert.ok(p.match instanceof RegExp, `${p.module} missing match`);
      assert.strictEqual(typeof p.module, 'string');
      assert.strictEqual(typeof p.apply, 'function');
    }
  });

  it('cookieSecurity pattern flips httpOnly: false → true', () => {
    const p = BUILTIN_PATTERNS.find(p => p.module === 'cookieSecurity' && p.match.test('httpOnly: false'));
    assert.ok(p);
    const result = p.apply('app.use(session({ httpOnly: false, secure: true }))');
    assert.ok(result.includes('httpOnly: true'));
    assert.ok(!result.includes('httpOnly: false'));
  });

  it('tlsSecurity pattern flips rejectUnauthorized: false → true', () => {
    const p = BUILTIN_PATTERNS.find(p => p.module === 'tlsSecurity' && p.match.test('rejectUnauthorized: false'));
    assert.ok(p);
    const result = p.apply('const agent = new https.Agent({ rejectUnauthorized: false });');
    assert.ok(result.includes('rejectUnauthorized: true'));
  });

  it('asyncIteration pattern replaces .forEach(async with .map(async', () => {
    const p = BUILTIN_PATTERNS.find(p => p.module === 'asyncIteration');
    assert.ok(p);
    const result = p.apply('items.forEach(async (item) => await process(item));');
    assert.ok(result.includes('.map(async'));
    assert.ok(!result.includes('.forEach(async'));
  });

  it('tlsSecurity removes NODE_TLS_REJECT_UNAUTHORIZED = "0" lines', () => {
    const p = BUILTIN_PATTERNS.find(
      p => p.module === 'tlsSecurity' && p.match.test('NODE_TLS_REJECT_UNAUTHORIZED = "0"')
    );
    assert.ok(p);
    const input = 'const a = 1;\nprocess.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\nconst b = 2;';
    const result = p.apply(input);
    assert.ok(!result.includes('NODE_TLS_REJECT_UNAUTHORIZED'));
    assert.ok(result.includes('const a = 1;'));
    assert.ok(result.includes('const b = 2;'));
  });
});

// ─── DirectRepair._applyUnifiedDiff ──────────────────────────────────────────

describe('DirectRepair — unified diff application', () => {
  let engine;
  before(() => { engine = new DirectRepair({ dryRun: true }); });

  it('applies a simple substitution hunk', () => {
    const original = 'line1\nline2\nline3\n';
    const diff = [
      '--- a/file',
      '+++ b/file',
      '@@ -2,1 +2,1 @@',
      '-line2',
      '+LINE2',
    ].join('\n');
    const result = engine._applyUnifiedDiff(original, diff);
    assert.ok(result.includes('LINE2'));
    assert.ok(!result.includes('line2'));
  });

  it('returns original when diff is empty', () => {
    const original = 'hello world\n';
    const result = engine._applyUnifiedDiff(original, '');
    assert.strictEqual(result, original);
  });
});

// ─── DirectRepair — dry-run end-to-end with mock scan ────────────────────────

describe('DirectRepair — dry-run with builtin patterns', () => {
  it('applies builtin cookieSecurity fix without writing or pushing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr-'));
    try {
      // Set up a fake workspace (skip the clone step by calling _applyFixes directly)
      const srcFile = path.join(tmp, 'src', 'server.js');
      fs.mkdirSync(path.dirname(srcFile), { recursive: true });
      fs.writeFileSync(srcFile, 'app.use(session({ httpOnly: false, secret: "x" }));\n');

      const engine = new DirectRepair({ dryRun: true });
      const report = {
        findings: [{
          module: 'cookieSecurity',
          file: 'src/server.js',
          detail: 'httpOnly: false — cookie readable from document.cookie',
          severity: 'error',
          pHash: patternHash('cookieSecurity', 'httpOnly: false'),
        }],
        fixes: [],
        skipped: [],
        cacheHits: 0,
        claudeCalls: 0,
      };

      await engine._applyFixes(tmp, report);

      assert.strictEqual(report.fixes.length, 1);
      assert.strictEqual(report.fixes[0].strategy, 'builtin');
      assert.ok(report.fixes[0].after.includes('httpOnly: true'));
      // dryRun=true — original file must be unchanged
      const onDisk = fs.readFileSync(srcFile, 'utf8');
      assert.ok(onDisk.includes('httpOnly: false'), 'dry-run must not write to disk');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stores claude fix in pattern cache for next run', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr-cache-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cache-'));
    try {
      const srcFile = path.join(tmp, 'src', 'util.js');
      fs.mkdirSync(path.dirname(srcFile), { recursive: true });
      fs.writeFileSync(srcFile, 'function x() { return 1; }\n');

      let claudeCalled = 0;
      const engine = new DirectRepair({
        dryRun: true,
        cacheDir,
        claudeFn: async () => {
          claudeCalled++;
          return 'function x() { return 2; }\n'; // fake fixed content
        },
      });

      const finding = {
        module: 'codeQuality',
        file: 'src/util.js',
        detail: 'magic-number: return 1 — use a named constant',
        severity: 'warning',
        pHash: patternHash('codeQuality', 'magic-number: return N'),
      };

      const report1 = { findings: [finding], fixes: [], skipped: [], cacheHits: 0, claudeCalls: 0 };
      await engine._applyFixes(tmp, report1);
      assert.strictEqual(claudeCalled, 1);
      assert.strictEqual(report1.fixes[0].strategy, 'claude');

      // Second engine with same cache — should NOT call Claude
      const engine2 = new DirectRepair({ dryRun: true, cacheDir, claudeFn: async () => { claudeCalled++; return null; } });
      fs.writeFileSync(srcFile, 'function x() { return 1; }\n'); // reset
      const report2 = { findings: [finding], fixes: [], skipped: [], cacheHits: 0, claudeCalls: 0 };
      await engine2._applyFixes(tmp, report2);
      assert.strictEqual(claudeCalled, 1, 'Claude should NOT be called second time');
      assert.strictEqual(report2.fixes[0].strategy, 'cache');
      assert.strictEqual(report2.cacheHits, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('skips findings with no file path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr-skip-'));
    try {
      const engine = new DirectRepair({ dryRun: true });
      const report = {
        findings: [{ module: 'lint', file: null, detail: 'some issue', severity: 'warning', pHash: 'abc' }],
        fixes: [], skipped: [], cacheHits: 0, claudeCalls: 0,
      };
      await engine._applyFixes(tmp, report);
      assert.strictEqual(report.fixes.length, 0);
      assert.strictEqual(report.skipped[0].reason, 'no-file-path');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips findings where file does not exist in workspace', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr-nofile-'));
    try {
      const engine = new DirectRepair({ dryRun: true });
      const report = {
        findings: [{ module: 'lint', file: 'does/not/exist.js', detail: 'x', severity: 'error', pHash: 'abc' }],
        fixes: [], skipped: [], cacheHits: 0, claudeCalls: 0,
      };
      await engine._applyFixes(tmp, report);
      assert.strictEqual(report.skipped[0].reason, 'file-not-found');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── injectCredential (via repair with bad clone — tests URL injection) ───────

describe('DirectRepair — credential injection', () => {
  it('engine constructs without throwing', () => {
    const e = new DirectRepair({ dryRun: true });
    assert.ok(e);
  });

  it('repair returns error report when clone fails (no such repo)', async () => {
    const engine = new DirectRepair({ dryRun: true });
    const report = await engine.repair('https://github.com/does-not-exist-at-all/no-such-repo-xyz', '', {});
    assert.ok(report.error, 'should have error on failed clone');
    assert.strictEqual(report.committed, false);
    assert.strictEqual(report.pushed, false);
  });
});
