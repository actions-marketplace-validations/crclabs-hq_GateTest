// ============================================================================
// PROPERTY-TEST-GENERATOR TEST — Phase 6.2.7 of THE 100-MOVES MASTER PLAN
// ============================================================================
// Pure-function coverage for the property-based test generator that runs
// alongside the regression-test generator on the Nuclear-tier fix path.
// askClaude is dependency-injected so tests don't hit the network.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  MAX_FIX_BYTES,
  TESTABLE_EXTS,
  isPropTestableFix,
  detectLanguage,
  buildPropTestPath,
  buildPropTestPrompt,
  generatePropTestForFix,
  generatePropTestsForFixes,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'property-test-generator.js'));

// ---------- shape ----------

test('exports the constants the doc promises', () => {
  assert.ok(MAX_FIX_BYTES > 0);
  assert.ok(Array.isArray(TESTABLE_EXTS));
  assert.ok(TESTABLE_EXTS.includes('ts'));
  assert.ok(TESTABLE_EXTS.includes('py'));
});

// ---------- isPropTestableFix ----------

describe('isPropTestableFix', () => {
  it('accepts a normal JS source file', () => {
    assert.strictEqual(
      isPropTestableFix({ file: 'src/foo.ts', original: 'old', fixed: 'new' }),
      true
    );
  });

  it('rejects test files, snapshots, configs, and dotfiles', () => {
    assert.strictEqual(isPropTestableFix({ file: 'src/foo.test.ts', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: 'src/foo.spec.js', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: '__tests__/foo.ts', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: 'tests/foo.ts', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: 'next.config.ts', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: 'foo.snap', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: 'foo.d.ts', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: '.gitignore', original: 'a', fixed: 'b' }), false);
  });

  it('rejects non-source extensions', () => {
    assert.strictEqual(isPropTestableFix({ file: 'README.md', original: 'a', fixed: 'b' }), false);
    assert.strictEqual(isPropTestableFix({ file: 'package.json', original: 'a', fixed: 'b' }), false);
  });

  it('rejects CREATE_FILE entries (no original content)', () => {
    assert.strictEqual(isPropTestableFix({ file: 'src/foo.ts', original: '', fixed: 'new' }), false);
  });

  it('rejects oversized fix output', () => {
    const big = 'x'.repeat(MAX_FIX_BYTES + 1);
    assert.strictEqual(isPropTestableFix({ file: 'src/foo.ts', original: 'a', fixed: big }), false);
  });

  it('rejects garbage input', () => {
    assert.strictEqual(isPropTestableFix(null), false);
    assert.strictEqual(isPropTestableFix({}), false);
    assert.strictEqual(isPropTestableFix({ file: 'a' }), false);
  });

  it('accepts Python source', () => {
    assert.strictEqual(
      isPropTestableFix({ file: 'src/calc.py', original: 'def f(x): return x', fixed: 'def f(x): return x*2' }),
      true
    );
  });
});

// ---------- detectLanguage ----------

describe('detectLanguage', () => {
  it('python for .py', () => {
    assert.strictEqual(detectLanguage('src/foo.py'), 'python');
  });

  it('javascript for everything else', () => {
    assert.strictEqual(detectLanguage('src/foo.ts'), 'javascript');
    assert.strictEqual(detectLanguage('src/foo.tsx'), 'javascript');
    assert.strictEqual(detectLanguage('src/foo.js'), 'javascript');
    assert.strictEqual(detectLanguage('src/foo.mjs'), 'javascript');
  });
});

// ---------- buildPropTestPath ----------

describe('buildPropTestPath', () => {
  it('puts tests under tests/auto-generated with .prop suffix', () => {
    assert.strictEqual(buildPropTestPath('src/foo.ts'), 'tests/auto-generated/src__foo.prop.ts');
    assert.strictEqual(buildPropTestPath('src/api/handler.js'), 'tests/auto-generated/src__api__handler.prop.js');
    assert.strictEqual(buildPropTestPath('src/calc.py'), 'tests/auto-generated/src__calc.prop.py');
  });

  it('TS family maps to .ts', () => {
    assert.strictEqual(buildPropTestPath('src/foo.tsx'), 'tests/auto-generated/src__foo.prop.ts');
    assert.strictEqual(buildPropTestPath('src/foo.mts'), 'tests/auto-generated/src__foo.prop.ts');
  });
});

// ---------- buildPropTestPrompt ----------

describe('buildPropTestPrompt', () => {
  it('JS prompt mentions fast-check + node:test', () => {
    const prompt = buildPropTestPrompt({
      filePath: 'src/foo.ts',
      fixedContent: 'export function f(x) { return x; }',
      issues: ['no-var'],
      language: 'javascript',
    });
    assert.match(prompt, /fast-check/);
    assert.match(prompt, /node:test/);
    assert.match(prompt, /numRuns: 200/);
    assert.match(prompt, /SKIP:/);
  });

  it('Python prompt mentions hypothesis + @given + @settings', () => {
    const prompt = buildPropTestPrompt({
      filePath: 'src/calc.py',
      fixedContent: 'def f(x): return x',
      issues: ['naming'],
      language: 'python',
    });
    assert.match(prompt, /hypothesis/);
    assert.match(prompt, /@given/);
    assert.match(prompt, /@settings\(max_examples=200\)/);
    assert.match(prompt, /SKIP:/);
  });

  it('includes the fixed code verbatim and issue list', () => {
    const prompt = buildPropTestPrompt({
      filePath: 'src/x.ts',
      fixedContent: 'const X = 42;',
      issues: ['issue one', 'issue two'],
      language: 'javascript',
    });
    assert.match(prompt, /const X = 42;/);
    assert.match(prompt, /1\. issue one/);
    assert.match(prompt, /2\. issue two/);
  });
});

// ---------- generatePropTestForFix ----------

describe('generatePropTestForFix', () => {
  it('returns skipped when fix is not testable', async () => {
    const out = await generatePropTestForFix({
      fix: { file: 'README.md', original: 'a', fixed: 'b' },
      askClaudeForTest: async () => '',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /not property-testable/);
  });

  it('returns skipped when ask wrapper is missing', async () => {
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.ts', original: 'a', fixed: 'b' },
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /no Claude wrapper/);
  });

  it('returns skipped when Claude returns SKIP', async () => {
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.ts', original: 'a', fixed: 'export const X = 1;', issues: ['x'] },
      askClaudeForTest: async () => 'SKIP: this is a constant, no function to test',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /model declined/);
  });

  it('returns skipped when Claude output does not import the property lib (JS)', async () => {
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.ts', original: 'a', fixed: 'export const f = x => x;', issues: ['x'] },
      askClaudeForTest: async () => 'import { test } from "node:test"; test("smoke", () => {});',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /fast-check/);
  });

  it('returns skipped when Claude output does not import hypothesis (Python)', async () => {
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.py', original: 'a', fixed: 'def f(x): return x', issues: ['x'] },
      askClaudeForTest: async () => 'def test_smoke(): assert True',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /hypothesis/);
  });

  it('happy path — JS — returns path/content/sourceFile/language', async () => {
    const goodOutput = `
import fc from 'fast-check';
import { test } from 'node:test';
import assert from 'node:assert';
test('idempotent', () => {
  fc.assert(fc.property(fc.integer(), (n) => f(f(n)) === f(n)), { numRuns: 200 });
});`;
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.ts', original: 'a', fixed: 'export const f = x => x;', issues: ['x'] },
      askClaudeForTest: async () => goodOutput,
    });
    assert.strictEqual(out.path, 'tests/auto-generated/src__foo.prop.ts');
    assert.strictEqual(out.sourceFile, 'src/foo.ts');
    assert.strictEqual(out.language, 'javascript');
    assert.match(out.content, /fast-check/);
    assert.match(out.content, /numRuns: 200/);
  });

  it('happy path — Python — returns path/content/sourceFile/language', async () => {
    const goodOutput = `
from hypothesis import given, settings, strategies as st
@given(st.integers())
@settings(max_examples=200)
def test_idempotent(x):
    assert f(f(x)) == f(x)
`;
    const out = await generatePropTestForFix({
      fix: { file: 'src/calc.py', original: 'a', fixed: 'def f(x): return x', issues: ['x'] },
      askClaudeForTest: async () => goodOutput,
    });
    assert.strictEqual(out.path, 'tests/auto-generated/src__calc.prop.py');
    assert.strictEqual(out.language, 'python');
    assert.match(out.content, /hypothesis/);
    assert.match(out.content, /@given/);
  });

  it('strips markdown code fences if Claude adds them', async () => {
    const fenced = '```typescript\nimport fc from "fast-check";\nfc.assert(fc.property(fc.integer(), () => true));\n```';
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.ts', original: 'a', fixed: 'b', issues: [] },
      askClaudeForTest: async () => fenced,
    });
    assert.strictEqual(out.content.startsWith('```'), false);
    assert.strictEqual(out.content.endsWith('```'), false);
    assert.match(out.content, /fast-check/);
  });

  it('survives a Claude throw without rethrowing (RELIABILITY contract)', async () => {
    const out = await generatePropTestForFix({
      fix: { file: 'src/foo.ts', original: 'a', fixed: 'b', issues: [] },
      askClaudeForTest: async () => { throw new Error('Anthropic 503'); },
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /Anthropic 503/);
  });
});

// ---------- generatePropTestsForFixes ----------

describe('generatePropTestsForFixes', () => {
  const happy = async () => `import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), () => true));`;

  it('returns empty for empty input', async () => {
    const out = await generatePropTestsForFixes({ fixes: [], askClaudeForTest: happy });
    assert.deepStrictEqual(out.tests, []);
    assert.deepStrictEqual(out.skipped, []);
  });

  it('returns sensible summary when no Claude wrapper supplied', async () => {
    const out = await generatePropTestsForFixes({ fixes: [{ file: 'a.ts', fixed: 'b', original: 'a' }] });
    assert.strictEqual(out.tests.length, 0);
    assert.strictEqual(out.skipped.length, 1);
    assert.match(out.summary, /no Claude wrapper/);
  });

  it('caps at maxFixes — extras land in summary as deferred', async () => {
    const fixes = [];
    for (let i = 0; i < 12; i++) {
      fixes.push({ file: `src/file${i}.ts`, original: 'a', fixed: 'b', issues: ['x'] });
    }
    const out = await generatePropTestsForFixes({ fixes, askClaudeForTest: happy, maxFixes: 5 });
    // 5 ran; 7 deferred — summary mentions overflow
    assert.match(out.summary, /7 additional fixes deferred/);
    assert.strictEqual(out.tests.length + out.skipped.length, 5);
  });

  it('returns mixed tests + skipped for mixed input', async () => {
    const fixes = [
      { file: 'src/a.ts', original: 'a', fixed: 'b', issues: ['x'] }, // testable
      { file: 'README.md', original: 'a', fixed: 'b', issues: ['x'] }, // skipped — not testable
      { file: 'src/c.py', original: 'a', fixed: 'def f(): pass', issues: ['x'] }, // testable
    ];
    const askClaudeForTest = async (prompt) => {
      // Return language-appropriate output
      if (/hypothesis/.test(prompt)) {
        return 'from hypothesis import given\n@given()\ndef test_x(): pass';
      }
      return 'import fc from "fast-check";\nfc.assert(fc.property(fc.integer(), () => true));';
    };
    const out = await generatePropTestsForFixes({ fixes, askClaudeForTest });
    assert.strictEqual(out.tests.length, 2);
    assert.strictEqual(out.skipped.length, 1);
    assert.match(out.summary, /2 generated, 1 skipped/);
  });
});
