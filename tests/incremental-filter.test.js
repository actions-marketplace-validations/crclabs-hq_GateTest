/**
 * Incremental filter tests — file-walker behaviour for the
 * `--since <ref>` / `--pr` feature.
 *
 * Covers:
 *   - BaseModule._collectFiles honours the per-instance file Set
 *   - universal-checker.runLanguageChecks honours options.incrementalFiles
 *   - config.incremental shape (skipList / alwaysRunList / sourceExtensions)
 *
 * Runner-side tests live in incremental-scan.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const BaseModule = require('../src/modules/base-module');
const { runLanguageChecks } = require('../src/core/universal-checker');
const { GateTestConfig } = require('../src/core/config');
const { TestResult } = require('../src/core/runner');

function write(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe('BaseModule._collectFiles — incremental filter', () => {
  it('returns ALL files when no incremental Set is set (default behaviour)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-collect-'));
    try {
      write(dir, 'a.js', '');
      write(dir, 'b.js', '');
      write(dir, 'c.js', '');

      const m = new BaseModule('test', 'test');
      const files = m._collectFiles(dir, ['.js']);
      assert.strictEqual(files.length, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters to ONLY incremental files when stash is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-collect-'));
    try {
      const a = write(dir, 'a.js', '');
      write(dir, 'b.js', '');
      const c = write(dir, 'c.js', '');

      const m = new BaseModule('test', 'test');
      m._currentIncrementalFiles = new Set([
        path.resolve(a),
        path.resolve(c),
      ]);
      const files = m._collectFiles(dir, ['.js']);
      assert.deepStrictEqual(
        files.map((f) => path.basename(f)).sort(),
        ['a.js', 'c.js'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours an empty Set as "no filter" (defensive)', () => {
    // An empty Set is the same as "no incremental filter is in effect" —
    // protects against a misconfigured pipeline accidentally skipping
    // every file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-collect-'));
    try {
      write(dir, 'a.js', '');
      const m = new BaseModule('test', 'test');
      m._currentIncrementalFiles = new Set();
      const files = m._collectFiles(dir, ['.js']);
      assert.strictEqual(files.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the patterns + excludes filter alongside the incremental filter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-collect-'));
    try {
      const a = write(dir, 'a.js', '');
      const b = write(dir, 'b.txt', ''); // wrong extension

      const m = new BaseModule('test', 'test');
      m._currentIncrementalFiles = new Set([
        path.resolve(a),
        path.resolve(b), // in the set but wrong extension
      ]);
      // Patterns filter to .js only; the .txt entry must be dropped
      // even though it's in the incremental set.
      const files = m._collectFiles(dir, ['.js']);
      assert.deepStrictEqual(
        files.map((f) => path.basename(f)),
        ['a.js'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('universal-checker.runLanguageChecks — incremental filter', () => {
  it('scans ONLY files in the incremental set when supplied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-uc-'));
    try {
      const inSet = write(dir, 'in.py', 'eval("1+1")\n');
      write(dir, 'out1.py', 'eval("2+2")\n');
      write(dir, 'out2.py', 'eval("3+3")\n');

      // No filter — all three should fire
      const fullResult = new TestResult('python');
      fullResult.start();
      runLanguageChecks('python', dir, fullResult);
      const fullEvalCount = fullResult.checks.filter(
        (c) => c.name.startsWith('python:eval:'),
      ).length;
      assert.strictEqual(fullEvalCount, 3);

      // With filter — only `in.py` fires
      const incResult = new TestResult('python');
      incResult.start();
      runLanguageChecks('python', dir, incResult, {
        incrementalFiles: new Set([path.resolve(inSet)]),
      });
      const incEvalCount = incResult.checks.filter(
        (c) => c.name.startsWith('python:eval:'),
      ).length;
      assert.strictEqual(incEvalCount, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports "no files changed since base ref" when filter empties the list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-uc-'));
    try {
      write(dir, 'a.py', 'eval("1")\n');
      const result = new TestResult('python');
      result.start();
      runLanguageChecks('python', dir, result, {
        incrementalFiles: new Set(['/tmp/nonexistent/xyz.py']),
      });
      const noFiles = result.checks.find((c) => c.name === 'python:no-files');
      assert.ok(noFiles);
      assert.match(noFiles.message, /changed since base ref/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Set with size 0 is treated as "no filter" (full scan)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-uc-'));
    try {
      write(dir, 'a.py', 'eval("1")\n');
      write(dir, 'b.py', 'eval("2")\n');
      const result = new TestResult('python');
      result.start();
      runLanguageChecks('python', dir, result, {
        incrementalFiles: new Set(),
      });
      const evalCount = result.checks.filter(
        (c) => c.name.startsWith('python:eval:'),
      ).length;
      assert.strictEqual(evalCount, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config.incremental shape', () => {
  it('skipList includes the canonical full-graph modules', () => {
    const cfg = new GateTestConfig(process.cwd());
    const skip = cfg.config.incremental.skipList;
    for (const m of ['importCycle', 'deadCode', 'crossFileTaint', 'openapiDrift']) {
      assert.ok(skip.includes(m), `${m} must be on the incremental skip list`);
    }
  });

  it('alwaysRunList includes secretRotation and prSize', () => {
    const cfg = new GateTestConfig(process.cwd());
    const always = cfg.config.incremental.alwaysRunList;
    assert.ok(always.includes('secretRotation'));
    assert.ok(always.includes('prSize'));
  });

  it('source extensions include js/ts/py/go/rs/json/yml/md/sh', () => {
    const cfg = new GateTestConfig(process.cwd());
    const exts = cfg.config.incremental.sourceExtensions;
    for (const e of ['.js', '.ts', '.tsx', '.py', '.go', '.rs', '.json', '.yml', '.md', '.sh']) {
      assert.ok(exts.includes(e), `${e} must be in the source-extension allowlist`);
    }
  });
});
