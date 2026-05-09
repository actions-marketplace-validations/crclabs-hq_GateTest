/**
 * Incremental scan tests — the `--since <ref>` / `--pr` CLI feature.
 *
 * Covers:
 *   - CLI flag parsing (--since, --pr) — done by spawning the bin
 *   - git diff invocation (against a real on-disk git repo)
 *   - source-extension filter (yml/json/md kept, .lock/.png dropped)
 *   - existing-on-disk filter (deleted-since-ref entries removed)
 *   - no-changes case → exit 0 with "nothing to scan" message
 *   - git-failure fallback → warning + full scan
 *   - BaseModule._collectFiles honours config._incrementalFiles
 *   - universal-checker.runLanguageChecks honours options.incrementalFiles
 *   - runner skip-list (importCycle etc.) → skipped, never run
 *   - runner alwaysRun-list (secretRotation, prSize) → run with no filter
 *   - default invocation (no --since) is byte-identical to before
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync, spawnSync } = require('node:child_process');

const { GateTestRunner, TestResult } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');
const BaseModule = require('../src/modules/base-module');
const { runLanguageChecks } = require('../src/core/universal-checker');

const BIN = path.resolve(__dirname, '..', 'bin', 'gatetest.js');

/** Build a throwaway git repo for git-aware tests. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-incremental-'));
  const run = (cmd) =>
    execSync(cmd, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  run('git init -q');
  run('git config user.email "test@example.com"');
  run('git config user.name  "Test"');
  // Signing must be disabled — many sandboxed CI environments don't have
  // a configured signing key and the test isn't about commit signing.
  run('git config commit.gpgsign false');
  run('git config tag.gpgsign false');
  run('git commit --allow-empty -q -m "root"');
  return { dir, run };
}

function write(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe('CLI flag parsing — --since / --pr', () => {
  it('--help mentions --since and --pr', () => {
    const out = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf-8' });
    assert.strictEqual(out.status, 0);
    assert.match(out.stdout, /--since <ref>/);
    assert.match(out.stdout, /--pr\b/);
    assert.match(out.stdout, /Incremental scan/);
  });

  it('--pr is sugar for --since origin/main (option threading)', () => {
    // We can't introspect the CLI parse without exporting, so verify the
    // flag is recognised by passing --pr in a no-op invocation. The
    // CLI should not error on the unknown-flag path.
    const repo = makeRepo();
    try {
      // origin/main doesn't exist in this throwaway repo, so the runner
      // will fall back to a full scan with a warning. Exit code reflects
      // gate result of an empty repo (PASSED) so should be 0.
      const out = spawnSync(
        process.execPath,
        [BIN, '--pr', '--module', 'syntax', '--project', repo.dir],
        { encoding: 'utf-8', timeout: 30000 },
      );
      // Either succeeded or fell back gracefully. The key is no crash
      // on the flag itself.
      assert.notStrictEqual(out.status, null, 'process must exit cleanly');
      assert.match(
        out.stdout + out.stderr,
        /(Incremental|nothing to scan|Falling back to full scan)/,
        'CLI must announce incremental behaviour, fallback, or empty result',
      );
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('runner._resolveIncrementalFiles — git diff invocation', () => {
  it('returns ACMR-changed source files against a real ref', () => {
    const repo = makeRepo();
    try {
      // Baseline state: one file committed on branch "base"
      write(repo.dir, 'src/keep.js', 'const x = 1;\n');
      repo.run('git add .');
      repo.run('git commit -q -m "baseline"');
      repo.run('git branch base');

      // Working-tree changes: one new file, one modified file
      write(repo.dir, 'src/new.js', 'const y = 2;\n');
      write(repo.dir, 'src/keep.js', 'const x = 99;\n');
      // Plus a non-source file that should be filtered out
      write(repo.dir, 'package-lock.json', '{}');
      repo.run('git add .');
      repo.run('git commit -q -m "feature"');

      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg);
      const result = runner._resolveIncrementalFiles('base');

      assert.ok(!result.error, `expected success, got error: ${result.error}`);
      const rels = result.files.map((f) => path.relative(repo.dir, f)).sort();
      assert.ok(rels.includes('src/new.js'), `new.js must be reported, got ${rels.join(',')}`);
      assert.ok(rels.includes('src/keep.js'), `keep.js must be reported, got ${rels.join(',')}`);
      // package-lock.json IS a .json source by our extension list — it's
      // valid for it to appear. The point of the filter is to exclude
      // binary blobs and unsupported extensions, not lockfiles.
      // We assert that no .png / .lock-style extension slipped through
      // by checking ALL files have a known source extension.
      const sourceExts = new Set(cfg.config.incremental.sourceExtensions);
      for (const f of result.files) {
        assert.ok(
          sourceExts.has(path.extname(f).toLowerCase()),
          `unexpected ext for ${f}`,
        );
      }
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('filters out files that no longer exist on disk', () => {
    const repo = makeRepo();
    try {
      write(repo.dir, 'src/a.js', 'a\n');
      write(repo.dir, 'src/b.js', 'b\n');
      repo.run('git add .');
      repo.run('git commit -q -m "two files"');
      repo.run('git branch base');

      // Now delete a.js and modify b.js — diff-filter ACMR excludes
      // deletions so a.js shouldn't appear, but if git's output ever
      // includes a stale entry we still shouldn't crash on a missing
      // file. Verify by running the resolve and confirming only b.js.
      fs.unlinkSync(path.join(repo.dir, 'src/a.js'));
      write(repo.dir, 'src/b.js', 'b!\n');
      repo.run('git add -A');
      repo.run('git commit -q -m "del a, modify b"');

      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg);
      const result = runner._resolveIncrementalFiles('base');
      assert.ok(!result.error);
      const rels = result.files.map((f) => path.relative(repo.dir, f));
      assert.deepStrictEqual(rels.sort(), ['src/b.js']);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('returns { error } when ref does not exist (graceful)', () => {
    const repo = makeRepo();
    try {
      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg);
      const result = runner._resolveIncrementalFiles('nonexistent-ref-xyz');
      assert.ok(result.error, 'must report an error string, never throw');
      assert.strictEqual(typeof result.error, 'string');
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('returns { error } when not in a git repo at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-nogit-'));
    try {
      const cfg = new GateTestConfig(dir);
      const runner = new GateTestRunner(cfg);
      const result = runner._resolveIncrementalFiles('main');
      assert.ok(result.error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty list when no source files changed', () => {
    const repo = makeRepo();
    try {
      // Commit only a non-source change vs base
      write(repo.dir, '.gatetest-marker', 'noop');
      repo.run('git add -A');
      repo.run('git commit -q -m "marker"');
      repo.run('git branch base');

      // No further changes
      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg);
      const result = runner._resolveIncrementalFiles('base');
      assert.ok(!result.error);
      assert.strictEqual(result.files.length, 0);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('runner.run — no-changes case', () => {
  it('exits with PASSED summary and runs zero modules when no source changed', async () => {
    const repo = makeRepo();
    try {
      write(repo.dir, '.gatetest-marker', 'noop');
      repo.run('git add -A');
      repo.run('git commit -q -m "noop"');
      repo.run('git branch base');

      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg, { incrementalSince: 'base' });

      // Register a module that would explode if run
      const explode = {
        name: 'explode',
        async run() { throw new Error('should never be called when no files changed'); },
      };
      runner.register('explode', explode);

      // Capture stdout to assert the friendly message
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      let summary;
      try {
        summary = await runner.run(['explode']);
      } finally {
        console.log = origLog;
      }

      assert.strictEqual(summary.gateStatus, 'PASSED');
      assert.strictEqual(summary.modules.total, 0);
      assert.strictEqual(summary.results.length, 0);
      assert.ok(summary.incremental);
      assert.strictEqual(summary.incremental.fileCount, 0);
      assert.ok(
        lines.some((l) => /No relevant files changed since base/.test(l)),
        `expected friendly empty message, got: ${lines.join('\n')}`,
      );
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('runner.run — git-failure fallback', () => {
  it('falls back to full scan with a warning when ref is invalid', async () => {
    const repo = makeRepo();
    try {
      write(repo.dir, 'src/a.js', 'a\n');
      repo.run('git add -A');
      repo.run('git commit -q -m "x"');

      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg, {
        incrementalSince: 'totally-not-a-ref',
      });

      let timesRan = 0;
      runner.register('counter', {
        name: 'counter',
        async run(result) {
          timesRan++;
          result.addCheck('ran', true, { severity: 'info' });
        },
      });

      const origWarn = console.warn;
      const warns = [];
      console.warn = (...args) => warns.push(args.join(' '));
      let summary;
      try {
        summary = await runner.run(['counter']);
      } finally {
        console.warn = origWarn;
      }

      assert.strictEqual(timesRan, 1, 'fallback must still run the modules');
      assert.strictEqual(summary.gateStatus, 'PASSED');
      assert.ok(
        warns.some((w) => /Incremental scan unavailable/.test(w)),
        `expected fallback warning, got: ${warns.join('\n')}`,
      );
      // After fallback, incrementalSince is cleared so summary reflects
      // a normal full scan
      assert.strictEqual(summary.incremental, null);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

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
    // An empty Set is the same as "no incremental filter is in effect".
    // This avoids the case where a misconfigured pipeline returns an
    // empty Set and accidentally skips everything.
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
});

describe('universal-checker.runLanguageChecks — incremental filter', () => {
  it('scans ONLY files in the incremental set when supplied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-uc-'));
    try {
      // Three .py files: only one in the incremental set should be scanned
      const inSet = write(dir, 'in.py', 'eval("1+1")\n');
      write(dir, 'out1.py', 'eval("2+2")\n');
      write(dir, 'out2.py', 'eval("3+3")\n');

      // First — no filter, all three should fire
      const fullResult = new TestResult('python');
      fullResult.start();
      runLanguageChecks('python', dir, fullResult);
      const fullEvalCount = fullResult.checks.filter(
        (c) => c.name.startsWith('python:eval:'),
      ).length;
      assert.strictEqual(fullEvalCount, 3);

      // Now — with filter, only `in.py` fires
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
      // Filter set has unrelated paths so nothing matches
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
});

describe('runner._runModule — incremental skip & alwaysRun lists', () => {
  it('skips importCycle (full-graph module) in incremental mode', async () => {
    const repo = makeRepo();
    try {
      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg, {
        incrementalSince: 'main',
        // Pre-populate so we don't re-resolve
        incrementalFiles: new Set([path.join(repo.dir, 'src/x.js')]),
      });
      let timesRan = 0;
      runner.register('importCycle', {
        name: 'importCycle',
        async run() { timesRan++; },
      });

      const result = await runner._runModule('importCycle');
      assert.strictEqual(timesRan, 0, 'skip-listed module must not run');
      assert.strictEqual(result.status, 'passed');
      assert.ok(
        result.checks.find((c) => c.name === 'incremental:skipped'),
        'must record an incremental:skipped info check',
      );
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('runs secretRotation (alwaysRun-listed) WITHOUT the file filter', async () => {
    const repo = makeRepo();
    try {
      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg, {
        incrementalSince: 'main',
        incrementalFiles: new Set([path.join(repo.dir, 'src/x.js')]),
      });
      let receivedFilter;
      runner.register('secretRotation', {
        name: 'secretRotation',
        async run(_result, modCfg) {
          receivedFilter = modCfg._incrementalFiles;
        },
      });
      await runner._runModule('secretRotation');
      assert.strictEqual(
        receivedFilter,
        undefined,
        'alwaysRun-listed module must NOT receive the incremental filter',
      );
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('passes the filter to a normal module', async () => {
    const repo = makeRepo();
    try {
      const cfg = new GateTestConfig(repo.dir);
      const filterSet = new Set([path.join(repo.dir, 'src/x.js')]);
      const runner = new GateTestRunner(cfg, {
        incrementalSince: 'main',
        incrementalFiles: filterSet,
      });
      let received;
      runner.register('syntax', {
        name: 'syntax',
        async run(_result, modCfg) {
          received = modCfg._incrementalFiles;
        },
      });
      await runner._runModule('syntax');
      assert.strictEqual(received, filterSet);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('default invocation is unchanged when --since is not set', () => {
  it('runner without incrementalSince behaves exactly as before', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-default-'));
    try {
      write(dir, 'a.js', 'const x = 1;\n');

      const cfg = new GateTestConfig(dir);
      const runner = new GateTestRunner(cfg);
      let modCfgSeen;
      runner.register('probe', {
        name: 'probe',
        async run(result, modCfg) {
          modCfgSeen = modCfg;
          result.addCheck('ran', true, { severity: 'info' });
        },
      });
      const summary = await runner.run(['probe']);
      assert.strictEqual(summary.gateStatus, 'PASSED');
      assert.strictEqual(summary.incremental, null);
      assert.strictEqual(modCfgSeen._incrementalFiles, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config — incremental.skipList includes the canonical full-graph modules', () => {
  it('importCycle / deadCode / crossFileTaint / openapiDrift are on the skip list', () => {
    const cfg = new GateTestConfig(process.cwd());
    const skip = cfg.config.incremental.skipList;
    for (const m of ['importCycle', 'deadCode', 'crossFileTaint', 'openapiDrift']) {
      assert.ok(skip.includes(m), `${m} must be on the incremental skip list`);
    }
  });

  it('secretRotation and prSize are on the alwaysRun list', () => {
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
