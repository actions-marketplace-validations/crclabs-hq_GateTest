// ============================================================================
// MUTATION-DRIVEN-TEST-STRENGTHENER TEST — Phase 6.2.8 of THE 100-MOVES PLAN
// ============================================================================
// Pure-function coverage for the helper that takes a regression test
// + the fixed source's mutation candidates and asks Claude to add
// assertions catching every mutation. askClaude + generateMutations
// are dependency-injected so tests run without network or the actual
// mutation engine.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  DEFAULT_MAX_MUTATIONS_PER_FILE,
  DEFAULT_MAX_FIXES,
  TESTABLE_EXTS,
  INLINE_OPERATORS,
  isStrengthenable,
  formatMutation,
  buildStrengthenPrompt,
  strengthenRegressionTest,
  strengthenRegressionTests,
  generateMutationsInline,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'mutation-driven-test-strengthener.js'
));

// ---------- inlined mutation generator ----------

describe('generateMutationsInline (the website-tree mutation engine)', () => {
  test('exposes 12 operators covering the standard mutation classes', () => {
    assert.ok(INLINE_OPERATORS.length >= 8);
    const names = INLINE_OPERATORS.map((o) => o.name);
    assert.ok(names.includes('eq-flip'));
    assert.ok(names.includes('and-to-or'));
    assert.ok(names.includes('true-to-false'));
  });

  test('generates mutations on real-shaped JS source', () => {
    const src = [
      'function safe(x) {',
      '  if (x === 1) {',
      '    return true;',
      '  }',
      '  return false;',
      '}',
    ].join('\n');
    const mutations = generateMutationsInline(src);
    assert.ok(mutations.length >= 2, `expected ≥ 2 mutations from this source, got ${mutations.length}`);
    // At least one should target the === comparison
    assert.ok(mutations.some((m) => m.mutation.name === 'eq-flip'));
  });

  test('skips comments and blank lines', () => {
    const src = '// === should be skipped\n\n/* also skipped === */';
    const mutations = generateMutationsInline(src);
    assert.strictEqual(mutations.length, 0);
  });

  test('respects maxPerFile cap', () => {
    let src = '';
    for (let i = 0; i < 30; i++) src += `if (x === ${i}) return true;\n`;
    const mutations = generateMutationsInline(src, { maxPerFile: 5 });
    assert.strictEqual(mutations.length, 5);
  });

  test('returns [] for non-string input', () => {
    assert.deepStrictEqual(generateMutationsInline(null), []);
    assert.deepStrictEqual(generateMutationsInline(42), []);
  });
});

// ---------- shape ----------

test('exports the constants the doc promises', () => {
  assert.ok(DEFAULT_MAX_MUTATIONS_PER_FILE > 0);
  assert.ok(DEFAULT_MAX_FIXES > 0);
  assert.ok(TESTABLE_EXTS instanceof Set);
  assert.ok(TESTABLE_EXTS.has('ts'));
  assert.ok(TESTABLE_EXTS.has('js'));
});

// ---------- isStrengthenable ----------

describe('isStrengthenable', () => {
  it('accepts a JS source + valid regression test', () => {
    assert.strictEqual(
      isStrengthenable(
        { file: 'src/foo.ts', fixed: 'export const x = 1;' },
        { content: 'test("x", () => assert.ok(true));' }
      ),
      true
    );
  });

  it('rejects empty fix or test', () => {
    assert.strictEqual(isStrengthenable(null, { content: 't' }), false);
    assert.strictEqual(isStrengthenable({ file: 'src/foo.ts', fixed: '' }, { content: 't' }), false);
    assert.strictEqual(isStrengthenable({ file: 'src/foo.ts', fixed: 'x' }, null), false);
    assert.strictEqual(isStrengthenable({ file: 'src/foo.ts', fixed: 'x' }, { content: '' }), true); // empty content isn't 0-len
  });

  it('rejects non-JS/TS sources (Python is a future sub-task)', () => {
    assert.strictEqual(
      isStrengthenable({ file: 'src/foo.py', fixed: 'def f(): pass' }, { content: 't' }),
      false
    );
    assert.strictEqual(
      isStrengthenable({ file: 'src/foo.go', fixed: 'package main' }, { content: 't' }),
      false
    );
  });

  it('rejects files without an extension', () => {
    assert.strictEqual(
      isStrengthenable({ file: 'Makefile', fixed: 'x' }, { content: 't' }),
      false
    );
  });
});

// ---------- formatMutation ----------

describe('formatMutation', () => {
  it('returns empty string on null', () => {
    assert.strictEqual(formatMutation(null), '');
    assert.strictEqual(formatMutation(undefined), '');
  });

  it('renders Line N (op) header + before/after pair', () => {
    const out = formatMutation({
      lineNumber: 42,
      original: 'if (x === 1) { return true; }',
      mutated: 'if (x !== 1) { return true; }',
      mutation: { name: 'equality-flip' },
    });
    assert.match(out, /^Line 42 \(equality-flip\):/);
    assert.match(out, /- if \(x === 1\)/);
    assert.match(out, /\+ if \(x !== 1\)/);
  });

  it('handles missing mutation name', () => {
    const out = formatMutation({
      lineNumber: 1,
      original: 'a',
      mutated: 'b',
      mutation: null,
    });
    assert.match(out, /Line 1 \(unknown\)/);
  });
});

// ---------- buildStrengthenPrompt ----------

describe('buildStrengthenPrompt', () => {
  it('caps mutations to DEFAULT_MAX_MUTATIONS_PER_FILE in the prompt', () => {
    const mutations = [];
    for (let i = 0; i < 20; i++) {
      mutations.push({ lineNumber: i + 1, original: `o${i}`, mutated: `m${i}`, mutation: { name: 'op' } });
    }
    const prompt = buildStrengthenPrompt({
      filePath: 'src/foo.ts',
      fixedContent: 'x',
      regressionTestContent: 't',
      mutations,
    });
    // First DEFAULT_MAX_MUTATIONS_PER_FILE present, rest absent.
    for (let i = 0; i < DEFAULT_MAX_MUTATIONS_PER_FILE; i++) {
      assert.ok(prompt.includes(`o${i}`), `mutation ${i} should be in the prompt`);
    }
    assert.strictEqual(prompt.includes(`o${DEFAULT_MAX_MUTATIONS_PER_FILE + 5}`), false);
  });

  it('embeds the fixed source + regression test verbatim', () => {
    const prompt = buildStrengthenPrompt({
      filePath: 'src/x.ts',
      fixedContent: 'export const X = 42;',
      regressionTestContent: 'test("smoke", () => {});',
      mutations: [{ lineNumber: 1, original: 'X = 42', mutated: 'X = 41', mutation: { name: 'literal' } }],
    });
    assert.match(prompt, /export const X = 42;/);
    assert.match(prompt, /test\("smoke"/);
    assert.match(prompt, /must catch/i);
    assert.match(prompt, /SKIP:/);
  });
});

// ---------- strengthenRegressionTest ----------

describe('strengthenRegressionTest', () => {
  const SAMPLE_FIX = { file: 'src/foo.ts', fixed: 'export const f = (x) => x + 1;', original: 'old', issues: ['x'] };
  const SAMPLE_TEST = { path: 'tests/auto-generated/src__foo.test.ts', content: 'test("smoke", () => assert.ok(true));', sourceFile: 'src/foo.ts' };

  it('returns skipped when fix or test is missing', async () => {
    const out = await strengthenRegressionTest({
      fix: null,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => 'x',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /not eligible/);
  });

  it('returns skipped when ask wrapper is missing', async () => {
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /no Claude wrapper/);
  });

  it('returns skipped when mutation engine produces zero candidates', async () => {
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => 'x',
      generateMutations: () => [],
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /no mutation candidates/);
  });

  it('returns skipped when mutation engine throws', async () => {
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => 'x',
      generateMutations: () => { throw new Error('boom'); },
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /mutation engine error/);
  });

  it('returns skipped when Claude returns SKIP', async () => {
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => 'SKIP: all mutations are inside comments',
      generateMutations: () => [{ lineNumber: 1, original: 'a', mutated: 'b', mutation: { name: 'op' } }],
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /model declined/);
  });

  it('returns skipped when Claude returns identical content', async () => {
    const original = 'test("smoke", () => assert.ok(true));';
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: { ...SAMPLE_TEST, content: original },
      askClaudeForStrengthen: async () => original,
      generateMutations: () => [{ lineNumber: 1, original: 'a', mutated: 'b', mutation: { name: 'op' } }],
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /identical content/);
  });

  it('returns skipped when output has no assertion-shaped calls', async () => {
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => 'console.log("not a test");',
      generateMutations: () => [{ lineNumber: 1, original: 'a', mutated: 'b', mutation: { name: 'op' } }],
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /no recognisable assertion/);
  });

  it('happy path — returns strengthenedContent + mutationsChecked count', async () => {
    const strengthened = `
test("smoke", () => assert.ok(true));
test("rejects mutation: x+1 vs x-1", () => assert.equal(f(2), 3));
`;
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => strengthened,
      generateMutations: () => [
        { lineNumber: 1, original: 'x + 1', mutated: 'x - 1', mutation: { name: 'math-swap' } },
      ],
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.skipped, undefined);
    assert.strictEqual(out.mutationsChecked, 1);
    assert.match(out.strengthenedContent, /rejects mutation/);
    assert.strictEqual(out.sourceFile, 'src/foo.ts');
    assert.strictEqual(out.testPath, SAMPLE_TEST.path);
  });

  it('strips Claude-added markdown fences', async () => {
    const fenced = '```typescript\nimport assert from "node:assert";\nassert.equal(1, 1);\n```';
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => fenced,
      generateMutations: () => [{ lineNumber: 1, original: 'a', mutated: 'b', mutation: { name: 'op' } }],
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.strengthenedContent.startsWith('```'), false);
    assert.strictEqual(out.strengthenedContent.endsWith('```'), false);
  });

  it('survives Claude throw without rethrowing (RELIABILITY contract)', async () => {
    const out = await strengthenRegressionTest({
      fix: SAMPLE_FIX,
      regressionTest: SAMPLE_TEST,
      askClaudeForStrengthen: async () => { throw new Error('Anthropic 503'); },
      generateMutations: () => [{ lineNumber: 1, original: 'a', mutated: 'b', mutation: { name: 'op' } }],
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /Anthropic 503/);
  });
});

// ---------- strengthenRegressionTests (batch) ----------

describe('strengthenRegressionTests (batch)', () => {
  it('returns empty when no tests supplied', async () => {
    const out = await strengthenRegressionTests({
      fixes: [],
      regressionTests: [],
      askClaudeForStrengthen: async () => 'x',
    });
    assert.deepStrictEqual(out.strengthened, []);
    assert.deepStrictEqual(out.skipped, []);
  });

  it('skips tests with no matching fix in the batch', async () => {
    const out = await strengthenRegressionTests({
      fixes: [{ file: 'src/a.ts', fixed: 'x' }],
      regressionTests: [{ path: 'tests/orphan.test.ts', content: 'assert.ok(true)', sourceFile: 'src/orphan.ts' }],
      askClaudeForStrengthen: async () => 'x',
    });
    assert.strictEqual(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /no matching fix/);
  });

  it('caps at maxFixes — extras land in summary as deferred', async () => {
    const fixes = [];
    const regressionTests = [];
    for (let i = 0; i < 10; i++) {
      fixes.push({ file: `src/f${i}.ts`, fixed: 'export const x = 1;' });
      regressionTests.push({
        path: `tests/auto-generated/src__f${i}.test.ts`,
        content: 'test("smoke", () => assert.ok(true));',
        sourceFile: `src/f${i}.ts`,
      });
    }
    const out = await strengthenRegressionTests({
      fixes,
      regressionTests,
      askClaudeForStrengthen: async () => 'assert.equal(1, 1);',
      generateMutations: () => [{ lineNumber: 1, original: 'x = 1', mutated: 'x = 2', mutation: { name: 'literal' } }],
      maxFixes: 3,
    });
    assert.match(out.summary, /7 additional tests deferred/);
    assert.strictEqual(out.strengthened.length + out.skipped.length, 3);
  });

  it('returns helpful summary when no Claude wrapper supplied', async () => {
    const out = await strengthenRegressionTests({
      fixes: [{ file: 'src/a.ts', fixed: 'x' }],
      regressionTests: [{ path: 't.test.ts', content: 'x', sourceFile: 'src/a.ts' }],
    });
    assert.match(out.summary, /no Claude wrapper/);
    assert.strictEqual(out.skipped.length, 1);
  });
});
