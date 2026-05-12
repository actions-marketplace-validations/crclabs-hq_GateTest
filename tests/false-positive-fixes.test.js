// ============================================================================
// FALSE-POSITIVE REGRESSION TESTS
// ============================================================================
// Lock in the fixes for two false-positive clusters that surfaced when
// GateTest was dogfooded against Crontech (754 errors / 1617 warnings,
// of which ~6,090 typescript-strict findings AND ~1,000+ .claude/worktrees
// findings turned out to be scanner bugs, not real Crontech issues).
//
// Both bugs:
//   1. base-module.js: .claude/ wasn't in defaultExcludes, so every
//      module that walked the file tree double-scanned the agent
//      worktree scratch directories.
//   2. syntax.js: _checkTypeScript ran `npx tsc --noEmit` against any
//      directory containing a tsconfig.json, including STUB tsconfigs
//      at monorepo roots (Crontech, Turborepo, etc.) that lack
//      compilerOptions. Result: TS6142 "jsx not set" / TS6053 "no
//      inputs found" noise — none of which are real customer bugs.
//
// These tests assert the fixes stay fixed.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BaseModule = require('../src/modules/base-module');
const SyntaxModule = require('../src/modules/syntax');

class TestableModule extends BaseModule {
  constructor() { super('test', 'Test wrapper'); }
  async run() {}
}

function makeTmp(prefix = 'gatetest-fp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// path.relative emits backslashes on Windows; tests assert forward-slash
// strings for cross-OS readability. Normalise once here so every test
// compares on the same separator regardless of host OS.
function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

// ---------- Bug 1: .claude/ excluded by default ----------

test('regression — .claude/worktrees/ is in defaultExcludes (bug from Crontech dogfood)', () => {
  const root = makeTmp();
  try {
    writeFile(root, 'src/real.js', '// real source\n');
    writeFile(root, '.claude/worktrees/agent-abc/src/copy.js', '// duplicate copy\n');
    writeFile(root, '.claude/scratch/notes.js', '// agent scratch\n');

    const mod = new TestableModule();
    const collected = mod._collectFiles(root, ['.js']);
    const paths = collected.map((p) => rel(root, p));

    // The real source file IS collected
    assert.ok(paths.includes('src/real.js'), 'src/real.js should be collected');

    // No .claude/ paths leak through
    const leaked = paths.filter((r) => r.startsWith('.claude'));
    assert.deepEqual(leaked, [], `expected zero .claude paths, got: ${leaked.join(', ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — .claude in default excludes coexists with caller-supplied excludes', () => {
  const root = makeTmp();
  try {
    writeFile(root, 'src/keep.js', 'a');
    writeFile(root, 'experiments/skip.js', 'b');
    writeFile(root, '.claude/worktrees/x/y.js', 'c');

    const mod = new TestableModule();
    const collected = mod._collectFiles(root, ['.js'], ['experiments']);
    const paths = collected.map((p) => rel(root, p)).sort();

    // src/keep.js included; experiments/ + .claude/ both excluded
    assert.deepEqual(paths, ['src/keep.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- Bug 2: stub tsconfig at monorepo root no longer fires tsc ----------

test('regression — stub tsconfig (no compilerOptions) is skipped by _discoverRealTsconfigs', () => {
  const root = makeTmp();
  try {
    // Stub root config — exists but has no compilerOptions. Crontech-style.
    writeFile(root, 'tsconfig.json', '{ "files": [] }');

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);

    assert.deepEqual(found, [], 'stub tsconfig (no compilerOptions) must NOT be returned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — extends-only tsconfig is skipped (no own compilerOptions)', () => {
  const root = makeTmp();
  try {
    // Extends-only stub: a real config exists in a workspace but the
    // root just inherits — running tsc at the root produces TS noise.
    writeFile(root, 'tsconfig.json', '{ "extends": "./tsconfig.base.json" }');
    writeFile(root, 'tsconfig.base.json', '{ "compilerOptions": { "target": "ES2020" } }');

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);

    // Only the base is real — but we don't return base because nothing
    // says "tsc against tsconfig.base.json". The root config is the
    // entry point and it's a stub. So zero results is correct.
    assert.deepEqual(found, [], 'extends-only root tsconfig must be skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — real root tsconfig (with compilerOptions) IS discovered', () => {
  const root = makeTmp();
  try {
    writeFile(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'commonjs', strict: true },
    }));

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);

    assert.equal(found.length, 1);
    assert.equal(found[0], root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — JSX-configured monorepo workspace (apps/web) IS discovered', () => {
  const root = makeTmp();
  try {
    // Crontech-shaped layout: stub root, real configs in apps/* + packages/*
    writeFile(root, 'tsconfig.json', '{ "files": [] }'); // stub
    writeFile(root, 'apps/web/tsconfig.json', JSON.stringify({
      compilerOptions: { jsx: 'preserve', target: 'ES2020' },
    }));
    writeFile(root, 'apps/api/tsconfig.json', JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2020' },
    }));
    writeFile(root, 'packages/shared/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020' },
    }));

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);

    const paths = found.map((p) => rel(root, p)).sort();
    assert.deepEqual(paths, ['apps/api', 'apps/web', 'packages/shared']);
    // Notably the root is NOT included
    assert.ok(!found.includes(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — descent stops at depth 2 (does not walk into node_modules-deep configs)', () => {
  const root = makeTmp();
  try {
    writeFile(root, 'apps/web/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020' },
    }));
    // Three levels deep — should NOT be discovered
    writeFile(root, 'apps/web/deep/sub/dir/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020' },
    }));

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);

    const paths = found.map((p) => rel(root, p));
    assert.ok(paths.includes('apps/web'));
    assert.ok(!paths.some((r) => r.includes('deep')), 'should not descend past depth 2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — node_modules + .claude excluded from tsconfig discovery', () => {
  const root = makeTmp();
  try {
    writeFile(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020' },
    }));
    // These should NEVER be discovered, even though they look "real"
    writeFile(root, 'node_modules/some-pkg/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020' },
    }));
    writeFile(root, '.claude/worktrees/agent-x/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020' },
    }));

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);
    const rel = found.map((p) => path.relative(root, p));

    assert.deepEqual(rel, [''], 'only the root config should be found');
    assert.ok(!found.some((p) => p.includes('node_modules')));
    assert.ok(!found.some((p) => p.includes('.claude')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression — JSONC-style comments in tsconfig.json are tolerated', () => {
  const root = makeTmp();
  try {
    // tsconfig is officially JSONC — TypeScript itself accepts comments.
    writeFile(root, 'tsconfig.json', `{
      // Compiler options for the root project
      "compilerOptions": {
        "target": "ES2020", /* block comment */
        "strict": true
      }
    }`);

    const mod = new SyntaxModule();
    const found = mod._discoverRealTsconfigs(root);

    assert.equal(found.length, 1);
    assert.equal(found[0], root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
