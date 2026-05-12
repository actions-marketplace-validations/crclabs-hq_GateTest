// ============================================================================
// CHAOS-TEST-GENERATOR TEST — Phase 6.2.9 of THE 100-MOVES PLAN
// ============================================================================
// Pure-function coverage for the chaos-test generator that runs alongside
// regression / property / perf-bench generators on the Nuclear-tier fix
// path. askClaude is dependency-injected so tests run without network.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  DEFAULT_MAX_FIXES,
  TESTABLE_EXTS,
  RESILIENCE_PATTERNS,
  looksResilienceRelevant,
  isChaosTestableFix,
  buildChaosTestPath,
  buildChaosTestPrompt,
  generateChaosTestForFix,
  generateChaosTestsForFixes,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'chaos-test-generator.js'
));

// ---------- shape ----------

test('exports the constants the doc promises', () => {
  assert.ok(DEFAULT_MAX_FIXES > 0);
  assert.ok(TESTABLE_EXTS instanceof Set);
  assert.ok(Array.isArray(RESILIENCE_PATTERNS));
  assert.ok(RESILIENCE_PATTERNS.length >= 10);
});

// ---------- looksResilienceRelevant ----------

describe('looksResilienceRelevant', () => {
  it('positive — fetch / axios / got', () => {
    assert.strictEqual(looksResilienceRelevant('await fetch("/api")'), true);
    assert.strictEqual(looksResilienceRelevant('axios.get(url)'), true);
    assert.strictEqual(looksResilienceRelevant('got("https://x")'), true);
  });

  it('positive — async / Promise patterns', () => {
    assert.strictEqual(looksResilienceRelevant('await fn()'), true);
    assert.strictEqual(looksResilienceRelevant('p.then((x) => x)'), true);
    assert.strictEqual(looksResilienceRelevant('new Promise((r) => r(1))'), true);
  });

  it('positive — timers', () => {
    assert.strictEqual(looksResilienceRelevant('setTimeout(() => x(), 100)'), true);
    assert.strictEqual(looksResilienceRelevant('setInterval(() => x(), 1000)'), true);
  });

  it('positive — file system + WebSocket', () => {
    assert.strictEqual(looksResilienceRelevant('fs.readFile(path, cb)'), true);
    assert.strictEqual(looksResilienceRelevant('new WebSocket(url)'), true);
  });

  it('positive — DB calls', () => {
    assert.strictEqual(looksResilienceRelevant('await prisma.user.findMany()'), true);
    assert.strictEqual(looksResilienceRelevant('db.query("SELECT *")'), true);
  });

  it('negative — pure-data transforms / constants', () => {
    assert.strictEqual(looksResilienceRelevant('export const X = 42;'), false);
    assert.strictEqual(looksResilienceRelevant('function add(a, b) { return a + b; }'), false);
  });

  it('returns false on empty / non-string', () => {
    assert.strictEqual(looksResilienceRelevant(null), false);
    assert.strictEqual(looksResilienceRelevant(''), false);
    assert.strictEqual(looksResilienceRelevant(42), false);
  });
});

// ---------- isChaosTestableFix ----------

describe('isChaosTestableFix', () => {
  it('accepts a JS source with resilience-relevant code', () => {
    assert.strictEqual(
      isChaosTestableFix({
        file: 'src/api/client.ts',
        original: 'fetch("/x")',
        fixed: 'await fetch("/x", { signal: AbortSignal.timeout(5000) })',
      }),
      true
    );
  });

  it('rejects pure-data sources without resilience surface', () => {
    assert.strictEqual(
      isChaosTestableFix({
        file: 'src/util.ts',
        original: 'export function add(a, b) { return a + b; }',
        fixed: 'export function add(a, b) { return Number(a) + Number(b); }',
      }),
      false
    );
  });

  it('rejects test files / configs / dotfiles', () => {
    assert.strictEqual(
      isChaosTestableFix({ file: 'src/foo.test.ts', original: 'fetch()', fixed: 'fetch()' }),
      false
    );
    assert.strictEqual(
      isChaosTestableFix({ file: 'next.config.ts', original: 'await x()', fixed: 'await x()' }),
      false
    );
  });

  it('rejects non-JS/TS sources (Python is future)', () => {
    assert.strictEqual(
      isChaosTestableFix({
        file: 'src/api.py',
        original: 'await client.get(url)',
        fixed: 'await client.get(url, timeout=5)',
      }),
      false
    );
  });

  it('rejects CREATE_FILE entries (no original to compare)', () => {
    assert.strictEqual(
      isChaosTestableFix({ file: 'src/new.ts', original: '', fixed: 'await fetch()' }),
      false
    );
  });
});

// ---------- buildChaosTestPath ----------

describe('buildChaosTestPath', () => {
  it('places chaos tests under tests/auto-generated/chaos/', () => {
    assert.strictEqual(
      buildChaosTestPath('src/api/client.ts'),
      'tests/auto-generated/chaos/src__api__client.chaos.ts'
    );
    assert.strictEqual(
      buildChaosTestPath('src/util.js'),
      'tests/auto-generated/chaos/src__util.chaos.js'
    );
  });

  it('TS family maps to .ts', () => {
    assert.strictEqual(
      buildChaosTestPath('src/foo.tsx'),
      'tests/auto-generated/chaos/src__foo.chaos.ts'
    );
  });
});

// ---------- buildChaosTestPrompt ----------

describe('buildChaosTestPrompt', () => {
  it('asks for node:test + at least 2 failure modes + SKIP escape', () => {
    const prompt = buildChaosTestPrompt({
      filePath: 'src/api.ts',
      fixedContent: 'await fetch("/x")',
      issues: ['no-timeout'],
    });
    assert.match(prompt, /node:test/);
    assert.match(prompt, /at least 2 of these failure modes/i);
    assert.match(prompt, /SKIP:/);
    assert.match(prompt, /Slow network/);
    assert.match(prompt, /Timeout/);
  });

  it('embeds fixed source verbatim and lists issues', () => {
    const prompt = buildChaosTestPrompt({
      filePath: 'src/x.ts',
      fixedContent: 'const r = await fetch("/x");',
      issues: ['no-retry', 'no-timeout'],
    });
    assert.match(prompt, /const r = await fetch\("\/x"\);/);
    assert.match(prompt, /1\. no-retry/);
    assert.match(prompt, /2\. no-timeout/);
  });
});

// ---------- generateChaosTestForFix ----------

describe('generateChaosTestForFix', () => {
  const HOT_FIX = {
    file: 'src/api/client.ts',
    original: 'fetch("/api/x")',
    fixed: 'await fetch("/api/x", { signal: AbortSignal.timeout(5000) })',
    issues: ['no-timeout'],
  };

  it('returns skipped when fix is not chaos-testable', async () => {
    const out = await generateChaosTestForFix({
      fix: { file: 'README.md', original: 'a', fixed: 'b' },
      askClaudeForChaos: async () => 'x',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /not chaos-testable/);
  });

  it('returns skipped when Claude wrapper is missing', async () => {
    const out = await generateChaosTestForFix({ fix: HOT_FIX });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /no Claude wrapper/);
  });

  it('returns skipped when Claude returns SKIP', async () => {
    const out = await generateChaosTestForFix({
      fix: HOT_FIX,
      askClaudeForChaos: async () => 'SKIP: pure data transformation',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /model declined/);
  });

  it('returns skipped when output is missing test runner', async () => {
    const out = await generateChaosTestForFix({
      fix: HOT_FIX,
      askClaudeForChaos: async () => 'console.log("not a test");',
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /test runner/);
  });

  it('returns skipped when output has no failure injection', async () => {
    const out = await generateChaosTestForFix({
      fix: HOT_FIX,
      askClaudeForChaos: async () => `
import { test } from "node:test";
test("smoke", () => { /* asserts something but never injects failure */ });
`,
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /failure injection/);
  });

  it('happy path — globalThis.fetch override → returns path/content/sourceFile', async () => {
    const goodOutput = `
import { test } from "node:test";
import assert from "node:assert";

test("survives slow network", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise((r) => setTimeout(() => r({ ok: true, json: async () => ({}) }), 100));
  try {
    const result = await myHandler();
    assert.ok(result);
  } finally {
    globalThis.fetch = original;
  }
});

test("recovers from dropped response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("ETIMEDOUT"));
  try {
    const result = await myHandler();
    assert.ok(result.fallback);
  } finally {
    globalThis.fetch = original;
  }
});
`;
    const out = await generateChaosTestForFix({
      fix: HOT_FIX,
      askClaudeForChaos: async () => goodOutput,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'tests/auto-generated/chaos/src__api__client.chaos.ts');
    assert.strictEqual(out.sourceFile, 'src/api/client.ts');
    assert.match(out.content, /globalThis\.fetch/);
  });

  it('strips Claude-added markdown fences', async () => {
    const fenced = '```ts\nimport { test } from "node:test";\nglobalThis.fetch = () => Promise.reject(new Error("x"));\ntest("y", () => {});\n```';
    const out = await generateChaosTestForFix({
      fix: HOT_FIX,
      askClaudeForChaos: async () => fenced,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.content.startsWith('```'), false);
  });

  it('survives Claude throw without rethrowing (RELIABILITY contract)', async () => {
    const out = await generateChaosTestForFix({
      fix: HOT_FIX,
      askClaudeForChaos: async () => { throw new Error('Anthropic 503'); },
    });
    assert.strictEqual(out.skipped, true);
    assert.match(out.reason, /Anthropic 503/);
  });
});

// ---------- generateChaosTestsForFixes (batch) ----------

describe('generateChaosTestsForFixes (batch)', () => {
  const happy = async () => `
import { test } from "node:test";
globalThis.fetch = () => Promise.reject(new Error("x"));
test("smoke", () => {});
`;

  it('returns empty for empty input', async () => {
    const out = await generateChaosTestsForFixes({ fixes: [], askClaudeForChaos: happy });
    assert.deepStrictEqual(out.tests, []);
  });

  it('returns helpful summary when no Claude wrapper', async () => {
    const out = await generateChaosTestsForFixes({
      fixes: [{ file: 'src/x.ts', original: 'fetch()', fixed: 'fetch()' }],
    });
    assert.match(out.summary, /no Claude wrapper/);
  });

  it('caps at maxFixes — overflow surfaces in summary as deferred', async () => {
    const fixes = [];
    for (let i = 0; i < 8; i++) {
      fixes.push({
        file: `src/api${i}.ts`,
        original: 'fetch()',
        fixed: 'await fetch()',
        issues: ['x'],
      });
    }
    const out = await generateChaosTestsForFixes({ fixes, askClaudeForChaos: happy, maxFixes: 3 });
    assert.match(out.summary, /5 additional fixes deferred/);
    assert.strictEqual(out.tests.length + out.skipped.length, 3);
  });
});
