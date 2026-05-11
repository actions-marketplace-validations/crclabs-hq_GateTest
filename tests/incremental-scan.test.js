/**
 * Incremental scan tests — runner-side behaviour for `--since <ref>` /
 * `--pr`. Covers CLI flag parsing, git-diff invocation, no-changes,
 * git-failure fallback, and the skip / alwaysRun lists.
 *
 * Per-module file-filter behaviour lives in incremental-filter.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync, spawnSync } = require('node:child_process');

const { GateTestRunner } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');

const BIN = path.resolve(__dirname, '..', 'bin', 'gatetest.js');

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
  // Signing must be disabled — sandboxed CI envs may not have a key
  // configured and the test isn't about commit signing.
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

  it('--pr is recognised by the CLI parser (no unknown-flag crash)', () => {
    const repo = makeRepo();
    try {
      // origin/main doesn't exist in a throwaway repo, so the runner
      // falls back to a full scan with a clear warning. The test asserts
      // the FLAG itself is recognised and produces the expected
      // announcement / fallback / empty-result output.
      const out = spawnSync(
        process.execPath,
        [BIN, '--pr', '--module', 'syntax', '--project', repo.dir],
        { encoding: 'utf-8', timeout: 30000 },
      );
      assert.notStrictEqual(out.status, null, 'process must exit cleanly');
      assert.match(
        out.stdout + out.stderr,
        /(Incremental|nothing to scan|Falling back to full scan)/,
        'CLI must announce incremental, fallback, or empty result',
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
      write(repo.dir, 'src/keep.js', 'const x = 1;\n');
      repo.run('git add .');
      repo.run('git commit -q -m "baseline"');
      repo.run('git branch base');

      write(repo.dir, 'src/new.js', 'const y = 2;\n');
      write(repo.dir, 'src/keep.js', 'const x = 99;\n');
      write(repo.dir, 'package-lock.json', '{}');
      repo.run('git add .');
      repo.run('git commit -q -m "feature"');

      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg);
      const result = runner._resolveIncrementalFiles('base');

      assert.ok(!result.error, `expected success, got error: ${result.error}`);
      const rels = result.files.map((f) => path.relative(repo.dir, f)).sort();
      assert.ok(rels.includes('src/new.js'));
      assert.ok(rels.includes('src/keep.js'));
      // Verify every file has a known source extension
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
      write(repo.dir, '.gatetest-marker', 'noop');
      repo.run('git add -A');
      repo.run('git commit -q -m "marker"');
      repo.run('git branch base');

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
  it('returns PASSED summary with zero modules run', async () => {
    const repo = makeRepo();
    try {
      write(repo.dir, '.gatetest-marker', 'noop');
      repo.run('git add -A');
      repo.run('git commit -q -m "noop"');
      repo.run('git branch base');

      const cfg = new GateTestConfig(repo.dir);
      const runner = new GateTestRunner(cfg, { incrementalSince: 'base' });

      const explode = {
        name: 'explode',
        async run() { throw new Error('should never be called'); },
      };
      runner.register('explode', explode);

      const origErr = console.error;
      const lines = [];
      console.error = (...args) => lines.push(args.join(' '));
      let summary;
      try {
        summary = await runner.run(['explode']);
      } finally {
        console.error = origErr;
      }

      assert.strictEqual(summary.gateStatus, 'PASSED');
      assert.strictEqual(summary.modules.total, 0);
      assert.strictEqual(summary.results.length, 0);
      assert.ok(summary.incremental);
      assert.strictEqual(summary.incremental.fileCount, 0);
      assert.ok(
        lines.some((l) => /No relevant files changed since base/.test(l)),
        `expected friendly empty message`,
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
      assert.strictEqual(summary.incremental, null);
    } finally {
      fs.rmSync(repo.dir, { recursive: true, force: true });
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
        incrementalFiles: new Set([path.join(repo.dir, 'src/x.js')]),
      });
      let timesRan = 0;
      runner.register('importCycle', {
        name: 'importCycle',
        async run() { timesRan++; },
      });

      const result = await runner._runModule('importCycle');
      assert.strictEqual(timesRan, 0);
      assert.strictEqual(result.status, 'passed');
      assert.ok(
        result.checks.find((c) => c.name === 'incremental:skipped'),
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
      assert.strictEqual(receivedFilter, undefined);
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
