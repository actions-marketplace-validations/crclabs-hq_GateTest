// =============================================================================
// CLI-ENGINE-RUNNER TEST — website/app/lib/cli-engine-runner.js
// =============================================================================
// Bridges the website's in-memory fileContents to the full 94-module CLI
// engine. Closes the "91 vs 22 modules" honesty gap.
//
// Tests are real-engine — we mkdtemp a workspace, write a tiny fixture,
// run the CLI, assert the translated shape. No mocks. Slower but proves
// the integration end-to-end.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runFullEngine,
  translateSummary,
  writeFilesToWorkspace,
  isPathSafe,
  MAX_WORKSPACE_BYTES,
} = require('../website/app/lib/cli-engine-runner');

// ---------------------------------------------------------------------------
// isPathSafe — defence against path-traversal in fileContents.path
// ---------------------------------------------------------------------------

describe('isPathSafe', () => {
  const root = '/tmp/scan-workspace';

  it('allows relative subpaths under root', () => {
    assert.equal(isPathSafe(root, 'src/foo.js'), true);
    assert.equal(isPathSafe(root, 'deeply/nested/file.ts'), true);
  });

  it('rejects parent-escape paths', () => {
    assert.equal(isPathSafe(root, '../etc/passwd'), false);
    assert.equal(isPathSafe(root, '../../malicious'), false);
  });

  it('rejects absolute paths outside root', () => {
    assert.equal(isPathSafe(root, '/etc/passwd'), false);
    assert.equal(isPathSafe(root, '/var/log/foo'), false);
  });
});

// ---------------------------------------------------------------------------
// writeFilesToWorkspace — file materialisation
// ---------------------------------------------------------------------------

describe('writeFilesToWorkspace', () => {
  function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cli-runner-test-'));
  }

  it('writes valid files and counts them', () => {
    const ws = tmpWorkspace();
    try {
      const stats = writeFilesToWorkspace(ws, [
        { path: 'src/a.js', content: 'const x = 1;' },
        { path: 'src/b.js', content: 'const y = 2;' },
      ]);
      assert.equal(stats.filesWritten, 2);
      assert.equal(stats.filesSkipped, 0);
      assert.ok(fs.existsSync(path.join(ws, 'src/a.js')));
      assert.ok(fs.existsSync(path.join(ws, 'src/b.js')));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('skips path-traversal attempts without writing them', () => {
    const ws = tmpWorkspace();
    try {
      const stats = writeFilesToWorkspace(ws, [
        { path: '../escape.js', content: 'evil' },
        { path: 'src/good.js', content: 'safe' },
      ]);
      assert.equal(stats.filesWritten, 1);
      assert.equal(stats.filesSkipped, 1);
      assert.ok(fs.existsSync(path.join(ws, 'src/good.js')));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('skips entries with non-string path or content', () => {
    const ws = tmpWorkspace();
    try {
      const stats = writeFilesToWorkspace(ws, [
        { path: null, content: 'x' },
        { path: 'src/a.js', content: 42 },
        { path: 'src/b.js', content: 'ok' },
      ]);
      assert.equal(stats.filesWritten, 1);
      assert.equal(stats.filesSkipped, 2);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('stops at the workspace byte cap', () => {
    // Build a synthetic file map just over the cap.
    const big = 'x'.repeat(1024 * 1024); // 1 MB
    const files = [];
    const overshootCount = Math.ceil(MAX_WORKSPACE_BYTES / big.length) + 2;
    for (let i = 0; i < overshootCount; i++) {
      files.push({ path: `pad/${i}.txt`, content: big });
    }
    const ws = tmpWorkspace();
    try {
      const stats = writeFilesToWorkspace(ws, files);
      assert.ok(stats.bytesWritten <= MAX_WORKSPACE_BYTES);
      assert.ok(stats.filesWritten < overshootCount, 'cap was applied');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// translateSummary — CLI shape → website shape
// ---------------------------------------------------------------------------

describe('translateSummary', () => {
  it('handles empty results', () => {
    const out = translateSummary({ results: [] });
    assert.deepEqual(out, { modules: [], totalIssues: 0 });
  });

  it('classifies a clean module as passed', () => {
    const out = translateSummary({
      results: [{
        module: 'syntax',
        passed: 10, errors: 0, warnings: 0, info: 0,
        checks: [],
        duration: 50,
      }],
    });
    assert.equal(out.modules.length, 1);
    assert.equal(out.modules[0].status, 'passed');
    assert.equal(out.modules[0].issues, 0);
    assert.equal(out.totalIssues, 0);
  });

  it('classifies a module with errors as failed and adds details', () => {
    const out = translateSummary({
      results: [{
        module: 'secrets',
        passed: 5, errors: 2, warnings: 1, info: 0,
        checks: [
          { name: 'secrets:api-key', severity: 'error', passed: false,
            details: { message: 'API key hardcoded', file: 'src/db.js', line: 12 } },
          { name: 'secrets:slack', severity: 'error', passed: false,
            details: { message: 'Slack token found', file: 'src/api.js' } },
          { name: 'secrets:weak', severity: 'warning', passed: false,
            details: { message: 'Weak secret pattern' } },
        ],
        duration: 80,
      }],
    });
    const mod = out.modules[0];
    assert.equal(mod.status, 'failed');
    assert.equal(mod.issues, 3);
    assert.equal(out.totalIssues, 3);
    assert.ok(Array.isArray(mod.details));
    assert.match(mod.details[0], /\[error\] API key hardcoded/);
    assert.match(mod.details[0], /src\/db\.js:12/);
    assert.match(mod.details[1], /Slack token found/);
  });

  it('classifies a skipped module correctly', () => {
    const out = translateSummary({
      results: [{
        module: 'visual',
        passed: 0, errors: 0, warnings: 0, info: 0,
        checks: [], duration: 5,
        skipped: 'no baseline screenshots',
      }],
    });
    assert.equal(out.modules[0].status, 'skipped');
    assert.equal(out.modules[0].skipped, 'no baseline screenshots');
  });

  it('classifies a zero-checks no-skip module as skipped', () => {
    // No checks ran, no skip reason — treat as skipped rather than passing.
    const out = translateSummary({
      results: [{ module: 'x', passed: 0, errors: 0, warnings: 0, info: 0, checks: [], duration: 0 }],
    });
    assert.equal(out.modules[0].status, 'skipped');
  });

  it('caps details to 200 entries with an overflow footer', () => {
    const checks = Array.from({ length: 250 }, (_, i) => ({
      name: `mod:check${i}`, severity: 'warning', passed: false,
      details: { message: `finding ${i}` },
    }));
    const out = translateSummary({
      results: [{ module: 'lint', passed: 0, errors: 0, warnings: 250, info: 0, checks, duration: 10 }],
    });
    const details = out.modules[0].details;
    assert.equal(details.length, 201, '200 cap + 1 overflow line');
    assert.match(details[details.length - 1], /250 - 200 = 50 more|50 more finding/);
  });
});

// ---------------------------------------------------------------------------
// runFullEngine — END-TO-END against the real CLI engine
// ---------------------------------------------------------------------------

describe('runFullEngine — end-to-end', () => {
  it('runs the quick suite against a tiny clean fixture', async () => {
    const out = await runFullEngine({
      suite: 'quick',
      fileContents: [
        { path: 'README.md', content: '# project\n\nA tiny project.\n' },
        { path: 'src/index.js', content: 'module.exports = function add(a, b) { return a + b; };\n' },
      ],
      deadlineMs: Date.now() + 60_000,
    });
    assert.equal(out.engine, 'cli');
    assert.ok(Array.isArray(out.modules));
    assert.ok(out.modules.length > 0, `expected modules to run, got ${out.modules.length}`);
    // Quick suite should run MORE than 4 modules — that's the whole point of this commit.
    assert.ok(out.modules.length >= 10, `expected ≥10 modules in CLI quick suite, got ${out.modules.length}`);
    assert.ok(typeof out.totalIssues === 'number');
    assert.ok(typeof out.duration === 'number');
  });

  it('finds a forbidden pattern (console.log) in a tainted fixture', async () => {
    // Using console.log rather than a credential-shaped string because
    // GitHub push-protection blocks even synthetic vendor-prefixed keys
    // (sk_live_*, AKIA*, etc.) as a false positive. console.log is caught
    // by the codeQuality module's forbiddenPatterns and proves the same
    // thing — the engine ran and found real issues.
    const out = await runFullEngine({
      suite: 'quick',
      fileContents: [
        { path: 'src/leaky.js', content: 'function debug() { console.log("debug output"); }\n' },
      ],
      deadlineMs: Date.now() + 60_000,
    });
    const codeQuality = out.modules.find((m) => m.name === 'codeQuality');
    assert.ok(codeQuality, 'codeQuality module should have run');
    assert.ok(
      codeQuality.issues >= 1,
      `expected codeQuality to flag console.log, got ${codeQuality.issues} issues`
    );
  });

  it('returns empty result for empty fileContents', async () => {
    const out = await runFullEngine({
      suite: 'quick',
      fileContents: [],
      deadlineMs: Date.now() + 30_000,
    });
    assert.equal(out.totalIssues, 0);
    assert.deepEqual(out.modules, []);
  });

  it('throws TypeError for non-array fileContents', async () => {
    await assert.rejects(
      () => runFullEngine({ suite: 'quick', fileContents: 'not an array' }),
      /fileContents must be an array/
    );
  });
});
