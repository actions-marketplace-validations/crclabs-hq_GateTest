// ============================================================================
// PERF-BENCHMARK-GENERATOR TEST — Phase 6.2.10 of THE 100-MOVES PLAN
// ============================================================================
// Pure-function coverage for the benchmark generator that runs alongside
// regression + property tests on the Nuclear-tier fix path. askClaude is
// dependency-injected so tests run without network.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  DEFAULT_MAX_FIXES,
  TESTABLE_EXTS,
  HOT_PATH_PATTERNS,
  looksLikeHotPath,
  isBenchmarkableFix,
  buildBenchmarkPath,
  buildBenchmarkPrompt,
  generateBenchmarkForFix,
  generateBenchmarksForFixes,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'perf-benchmark-generator.js'
));

// ---------- shape ----------

test('exports the constants the doc promises', () => {
  assert.ok(DEFAULT_MAX_FIXES > 0);
  assert.ok(TESTABLE_EXTS instanceof Set);
  assert.ok(Array.isArray(HOT_PATH_PATTERNS));
  assert.ok(HOT_PATH_PATTERNS.length >= 5);
});

// ---------- looksLikeHotPath ----------

describe('looksLikeHotPath', () => {
  it('positive — for-loop', () => {
    assert.strictEqual(looksLikeHotPath('for (const x of list) { use(x); }'), true);
  });

  it('positive — while-loop', () => {
    assert.strictEqual(looksLikeHotPath('while (i < n) { i++; }'), true);
  });

  it('positive — Promise patterns', () => {
    assert.strictEqual(looksLikeHotPath('await fetchData()'), true);
    assert.strictEqual(looksLikeHotPath('promise.then((x) => x)'), true);
  });

  it('positive — array-method hot paths', () => {
    assert.strictEqual(looksLikeHotPath('arr.map((x) => x * 2)'), true);
    assert.strictEqual(looksLikeHotPath('arr.reduce((a, b) => a + b, 0)'), true);
  });

  it('positive — DB-shaped calls', () => {
    assert.strictEqual(looksLikeHotPath('await prisma.user.findMany()'), true);
    assert.strictEqual(looksLikeHotPath('db.query("SELECT *")'), true);
  });

  it('positive — fetch / regex literal', () => {
    assert.strictEqual(looksLikeHotPath('await fetch("/api/x")'), true);
  });

  it('negative — pure constants / type definitions', () => {
    assert.strictEqual(looksLikeHotPath('export const X = 42;'), false);
    assert.strictEqual(looksLikeHotPath('export interface Foo { bar: string; }'), false);
  });

  it('negative — comment-only', () => {
    assert.strictEqual(looksLikeHotPath('// just a comment'), false);
  });

  it('returns false on non-string / empty input', () => {
    assert.strictEqual(looksLikeHotPath(null), false);
    assert.strictEqual(looksLikeHotPath(''), false);
    assert.strictEqual(looksLikeHotPath(42), false);
  });
});

// ---------- isBenchmarkableFix ----------

describe('isBenchmarkableFix', () => {
  it('accepts JS source containing a hot-path signal', () => {
    assert.strictEqual(
      isBenchmarkableFix({
        file: 'src/api/handler.ts',
        original: 'for (const x of items) acc += x;',
        fixed: 'for (const x of items) { acc += x; }',
      }),
      true
    );
  });

  it('rejects sources with no hot-path signals (pure constants)', () => {
    assert.strictEqual(
      isBenchmarkableFix({
        file: 'src/constants.ts',
        original: 'export const X = 1;',
        fixed: 'export const X = 2;',
      }),
      false
    );
  });

  it('rejects test files / configs / dotfiles', () => {
    assert.strictEqual(
      isBenchmarkableFix({ file: 'src/foo.test.ts', original: 'for (;;){}', fixed: 'for (;;){}' }),
      false
    );
    assert.strictEqual(
      isBenchmarkableFix({ file: 'next.config.ts', original: 'await x()', fixed: 'await x()' }),
      false
    );
    assert.strictEqual(
      isBenchmarkableFix({ file: '.env', original: 'A=1', fixed: 'A=2' }),
      false
    );
  });

  it('rejects Python sources (future sub-task)', () => {
    assert.strictEqual(
      isBenchmarkableFix({
        file: 'src/calc.py',
        original: 'for x in items: pass',
        fixed: 'for x in items: print(x)',
      }),
      false
    );
  });

  it('rejects CREATE_FILE entries', () => {
    assert.strictEqual(
      isBenchmarkableFix({ file: 'src/new.ts', original: '', fixed: 'for (;;){}' }),
      false
    );
  });

  it('rejects garbage input', () => {
    assert.strictEqual(isBenchmarkableFix(null), false);
    assert.strictEqual(isBenchmarkableFix({}), false);
    assert.strictEqual(isBenchmarkableFix({ file: 'src/x.ts' }), false);
  });
});

// ---------- buildBenchmarkPath ----------

describe('buildBenchmarkPath', () => {
  it('places benchmarks under tests/auto-generated/benchmarks/', () => {
    assert.strictEqual(
      buildBenchmarkPath('src/api/handler.ts'),
      'tests/auto-generated/benchmarks/src__api__handler.bench.ts'
    );
    assert.strictEqual(
      buildBenchmarkPath('src/util.js'),
      'tests/auto-generated/benchmarks/src__util.bench.js'
    );
  });

  it('TS family maps to .ts', () => {
    assert.strictEqual(
      buildBenchmarkPath('src/foo.tsx'),
      'tests/auto-generated/benchmarks/src__foo.bench.ts'
    );
    assert.strictEqual(
      buildBenchmarkPath('src/foo.mts'),
      'tests/auto-generated/benchmarks/src__foo.bench.ts'
    );
  });
});

// ---------- buildBenchmarkPrompt ----------

describe('buildBenchmarkPrompt', () => {
  it('asks for tinybench + originalFn + fixedFn', () => {
    const prompt = buildBenchmarkPrompt({
      filePath: 'src/api.ts',
      originalContent: 'for (const x of arr) acc += x;',
      fixedContent: 'arr.reduce((a, b) => a + b, 0)',
      issues: ['n+1 query'],
    });
    assert.match(prompt, /tinybench/);
    assert.match(prompt, /originalFn/);
    assert.match(prompt, /fixedFn/);
    assert.match(prompt, /AT LEAST 2 inputs/);
    assert.match(prompt, /SKIP:/);
  });

  it('embeds both original and fixed source verbatim', () => {
    const prompt = buildBenchmarkPrompt({
      filePath: 'src/x.ts',
      originalContent: 'for (let i=0;i<n;i++) {}',
      fixedContent: 'arr.forEach(() => {})',
      issues: [],
    });
    assert.match(prompt, /for \(let i=0;i<n;i\+\+\) \{\}/);
    assert.match(prompt, /arr\.forEach\(\(\) => \{\}\)/);
  });
});

// ---------- generateBenchmarkForFix ----------

describe('generateBenchmarkForFix', () => {
  const HOT_FIX = {
    file: 'src/api/list.ts',
    original: 'for (const x of items) { acc.push(x * 2); }',
    fixed: 'const acc = items.map((x) => x * 2);',
    issues: ['use array methods'],
  };

  it('returns skipped when fix is not benchmarkable', async () => {
    const out = await generateBenchmarkForFix({
      fix: { file: 'README.md', original: 'a', fixed: 'b' },
      askClaudeForBench: async () => 'x',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /not benchmarkable/);
  });

  it('returns skipped when Claude wrapper is missing', async () => {
    const out = await generateBenchmarkForFix({ fix: HOT_FIX });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /no Claude wrapper/);
  });

  it('returns skipped when Claude returns SKIP', async () => {
    const out = await generateBenchmarkForFix({
      fix: HOT_FIX,
      askClaudeForBench: async () => 'SKIP: side-effect-only refactor, no return value',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /model declined/);
  });

  it('returns skipped when output lacks tinybench', async () => {
    const out = await generateBenchmarkForFix({
      fix: HOT_FIX,
      askClaudeForBench: async () => 'function originalFn(){} function fixedFn(){} // no Bench',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /tinybench/);
  });

  it('returns skipped when output lacks both fn names', async () => {
    const out = await generateBenchmarkForFix({
      fix: HOT_FIX,
      askClaudeForBench: async () => 'import { Bench } from "tinybench"; const b = new Bench();',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /originalFn and fixedFn/);
  });

  it('happy path — returns path/content/sourceFile', async () => {
    const goodOutput = `
import { Bench } from 'tinybench';

function originalFn(items) {
  const acc = [];
  for (const x of items) acc.push(x * 2);
  return acc;
}

function fixedFn(items) {
  return items.map((x) => x * 2);
}

const small = Array.from({ length: 100 }, (_, i) => i);
const large = Array.from({ length: 100000 }, (_, i) => i);

const bench = new Bench({ time: 500 });
bench.add('original (small)', () => originalFn(small));
bench.add('fixed (small)', () => fixedFn(small));
bench.add('original (large)', () => originalFn(large));
bench.add('fixed (large)', () => fixedFn(large));

await bench.run();
bench.tasks.forEach((t) => console.log(t.name, t.result));
`;
    const out = await generateBenchmarkForFix({
      fix: HOT_FIX,
      askClaudeForBench: async () => goodOutput,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'tests/auto-generated/benchmarks/src__api__list.bench.ts');
    assert.match(out.content, /tinybench/);
    assert.match(out.content, /originalFn/);
    assert.match(out.content, /fixedFn/);
  });

  it('strips Claude-added markdown fences', async () => {
    const fenced =
      '```ts\nimport { Bench } from "tinybench";\nfunction originalFn(){}\nfunction fixedFn(){}\nconst b = new Bench();\n```';
    const out = await generateBenchmarkForFix({
      fix: HOT_FIX,
      askClaudeForBench: async () => fenced,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.content.startsWith('```'), false);
    assert.strictEqual(out.content.endsWith('```'), false);
  });

  it('survives Claude throw without rethrowing (RELIABILITY contract)', async () => {
    const out = await generateBenchmarkForFix({
      fix: HOT_FIX,
      askClaudeForBench: async () => { throw new Error('Anthropic 503'); },
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /Anthropic 503/);
  });
});

// ---------- generateBenchmarksForFixes (batch) ----------

describe('generateBenchmarksForFixes (batch)', () => {
  const happy = async () =>
    'import { Bench } from "tinybench"; function originalFn(){} function fixedFn(){} const b = new Bench();';

  it('returns empty for empty input', async () => {
    const out = await generateBenchmarksForFixes({ fixes: [], askClaudeForBench: happy });
    assert.deepStrictEqual(out.benchmarks, []);
  });

  it('returns helpful summary when no Claude wrapper', async () => {
    const out = await generateBenchmarksForFixes({
      fixes: [{ file: 'src/x.ts', original: 'for(;;){}', fixed: 'for(;;){}' }],
    });
    assert.match(out.summary, /no Claude wrapper/);
    assert.strictEqual(out.benchmarks.length, 0);
    assert.strictEqual(out.skipped.length, 1);
  });

  it('caps at maxFixes — overflow surfaces in summary as deferred', async () => {
    const fixes = [];
    for (let i = 0; i < 12; i++) {
      fixes.push({
        file: `src/file${i}.ts`,
        original: 'for (;;){}',
        fixed: 'for (;;){}',
        issues: ['x'],
      });
    }
    const out = await generateBenchmarksForFixes({ fixes, askClaudeForBench: happy, maxFixes: 4 });
    assert.match(out.summary, /8 additional fixes deferred/);
    assert.strictEqual(out.benchmarks.length + out.skipped.length, 4);
  });

  it('returns mixed bench + skipped for mixed input', async () => {
    const fixes = [
      { file: 'src/hot.ts', original: 'for (;;){}', fixed: 'for (;;){}', issues: ['x'] },
      { file: 'src/cold.ts', original: 'export const X = 1;', fixed: 'export const X = 2;', issues: ['x'] },
    ];
    const out = await generateBenchmarksForFixes({ fixes, askClaudeForBench: happy });
    assert.strictEqual(out.benchmarks.length, 1);
    assert.strictEqual(out.skipped.length, 1);
    assert.match(out.summary, /1 generated, 1 skipped/);
  });
});
