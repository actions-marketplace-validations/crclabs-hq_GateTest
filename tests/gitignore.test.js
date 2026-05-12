// =============================================================================
// GITIGNORE TEST — phase-6 launch hardening
// =============================================================================
// Covers the standalone .gitignore parser used by safe-fs walkers to skip
// node_modules, dist/, build artefacts, and respect customer-defined skips.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  HARD_SKIP_DIRS,
  compilePattern,
  buildIgnoreMatcher,
} = require('../src/core/gitignore');

// =============================================================================
// compilePattern — unit
// =============================================================================

describe('compilePattern', () => {
  it('returns null for blank lines and comments', () => {
    assert.strictEqual(compilePattern(''), null);
    assert.strictEqual(compilePattern('   '), null);
    assert.strictEqual(compilePattern('# this is a comment'), null);
  });

  it('compiles a simple filename pattern (matches anywhere)', () => {
    const c = compilePattern('foo.log');
    assert.ok(c.regex.test('foo.log'));
    assert.ok(c.regex.test('a/b/foo.log'));
    assert.strictEqual(c.regex.test('foo.txt'), false);
  });

  it('honours leading slash as anchor', () => {
    const c = compilePattern('/foo.log');
    assert.ok(c.regex.test('foo.log'));
    assert.strictEqual(c.regex.test('a/foo.log'), false);
  });

  it('honours trailing slash as dir-only', () => {
    const c = compilePattern('build/');
    assert.strictEqual(c.dirOnly, true);
  });

  it('honours negation (!)', () => {
    const c = compilePattern('!important.log');
    assert.strictEqual(c.negate, true);
  });

  it('handles ** for cross-segment matching', () => {
    const c = compilePattern('**/temp');
    assert.ok(c.regex.test('temp'));
    assert.ok(c.regex.test('a/temp'));
    assert.ok(c.regex.test('a/b/c/temp'));
  });

  it('handles * as single-segment wildcard', () => {
    const c = compilePattern('*.bak');
    assert.ok(c.regex.test('foo.bak'));
    assert.ok(c.regex.test('a/foo.bak'));
    assert.strictEqual(c.regex.test('foo.bak.txt'), false);
  });
});

// =============================================================================
// buildIgnoreMatcher — fixture
// =============================================================================

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-gitignore-'));
  fs.writeFileSync(path.join(TMP, '.gitignore'), [
    '# Build outputs',
    'dist/',
    '*.log',
    '!important.log',
    '/secrets.env',
    'temp/**',
  ].join('\n'));

  fs.mkdirSync(path.join(TMP, 'src'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'src', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'src', '.gitignore'), [
    'private.ts',
  ].join('\n'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('buildIgnoreMatcher', () => {
  it('hard-skips node_modules even without a .gitignore entry', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('node_modules/lodash/index.js'), true);
    assert.strictEqual(m('a/node_modules/x.js'), true);
  });

  it('hard-skips .git', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('.git/HEAD'), true);
  });

  it('respects a root .gitignore entry', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('app.log'), true);
    assert.strictEqual(m('src/app.log'), true);
  });

  it('respects negation (!important.log)', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('important.log'), false);
  });

  it('honours anchored /secrets.env', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('secrets.env'), true);
    // unanchored under a subdir should NOT match
    assert.strictEqual(m('src/secrets.env'), false);
  });

  it('honours dir-only pattern (dist/)', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('dist/foo.js'), true);
    // Plain file named "dist" doesn't match the dir-only rule against its segment
  });

  it('respects nested .gitignore (src/private.ts)', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('src/private.ts'), true);
    // Outside src/, "private.ts" should not be ignored
    assert.strictEqual(m('private.ts'), false);
  });

  it('does not ignore unrelated files', () => {
    const m = buildIgnoreMatcher(TMP);
    assert.strictEqual(m('src/index.ts'), false);
    assert.strictEqual(m('README.md'), false);
  });
});

// =============================================================================
// Hard-skip exhaustive
// =============================================================================

describe('HARD_SKIP_DIRS', () => {
  it('includes the high-traffic noise sources', () => {
    for (const s of ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor']) {
      assert.ok(HARD_SKIP_DIRS.has(s), `missing hard-skip: ${s}`);
    }
  });
});
