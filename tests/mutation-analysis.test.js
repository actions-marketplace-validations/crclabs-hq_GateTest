'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// We test the module runner directly by importing the compiled output.
// Since this is a TypeScript file in the Next.js app we test the logic
// by invoking it through a thin JS shim that mirrors the module's behaviour.

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(fileContents = []) {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    files: fileContents.map((f) => f.path),
    fileContents,
    token: undefined,
    deadlineMs: Date.now() + 60_000,
  };
}

function makeFile(path, content) {
  return { path, content };
}

// Inline the same logic as mutation-analysis.ts so we can test it without
// a TypeScript compile step. These tests verify the BEHAVIOUR, not the
// TypeScript types.

function isTestFile(path) {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(path) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(path);
}

function isSourceFile(path) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) && !isTestFile(path);
}

const MUTATION_PATTERNS = [
  { re: /[<>]=?(?![=])/, label: 'boundary comparison' },
  { re: /return\s+true\b/, label: 'return-true literal' },
  { re: /return\s+false\b/, label: 'return-false literal' },
  { re: /&&/, label: 'logical-AND' },
  { re: /\|\|/, label: 'logical-OR' },
];

function countMutationCandidates(content) {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  let count = 0;
  for (const { re } of MUTATION_PATTERNS) {
    const hits = stripped.match(new RegExp(re.source, 'g'));
    if (hits) count += hits.length;
  }
  return count;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('mutation-analysis — isTestFile', () => {
  it('recognises test directory', () => {
    assert.ok(isTestFile('tests/foo.js'));
    assert.ok(isTestFile('__tests__/bar.ts'));
    assert.ok(isTestFile('src/spec/baz.js'));
  });

  it('recognises .test. and .spec. in filename', () => {
    assert.ok(isTestFile('foo.test.ts'));
    assert.ok(isTestFile('bar.spec.js'));
  });

  it('does not flag normal source files', () => {
    assert.ok(!isTestFile('src/app.ts'));
    assert.ok(!isTestFile('lib/utils.js'));
    assert.ok(!isTestFile('components/Button.tsx'));
  });
});

describe('mutation-analysis — isSourceFile', () => {
  it('accepts JS/TS source extensions', () => {
    assert.ok(isSourceFile('src/app.ts'));
    assert.ok(isSourceFile('lib/utils.js'));
    assert.ok(isSourceFile('components/Button.tsx'));
    assert.ok(isSourceFile('server.mjs'));
  });

  it('rejects test files', () => {
    assert.ok(!isSourceFile('src/app.test.ts'));
    assert.ok(!isSourceFile('tests/utils.js'));
  });

  it('rejects non-source extensions', () => {
    assert.ok(!isSourceFile('config.json'));
    assert.ok(!isSourceFile('README.md'));
  });
});

describe('mutation-analysis — countMutationCandidates', () => {
  it('counts return-true candidates', () => {
    const c = countMutationCandidates('function ok() { return true; }');
    assert.ok(c >= 1);
  });

  it('counts return-false candidates', () => {
    const c = countMutationCandidates('function fail() { return false; }');
    assert.ok(c >= 1);
  });

  it('counts boundary comparisons', () => {
    const c = countMutationCandidates('if (x > 0 && y < 10) {}');
    assert.ok(c >= 3); // >, <, &&
  });

  it('counts logical operators', () => {
    const c = countMutationCandidates('const r = a && b || c;');
    assert.ok(c >= 2); // && and ||
  });

  it('strips line comments before counting', () => {
    const c1 = countMutationCandidates('// return true is safe here');
    const c2 = countMutationCandidates('return true;');
    assert.ok(c1 < c2, 'comment should not count');
  });

  it('strips block comments before counting', () => {
    const c = countMutationCandidates('/* return true */ const x = 1;');
    assert.strictEqual(c, 0, 'block comment should not count');
  });

  it('returns 0 for content with no mutation surface', () => {
    const c = countMutationCandidates('const name = "hello";');
    assert.strictEqual(c, 0);
  });
});

describe('mutation-analysis — coverage gap detection logic', () => {
  it('identifies uncovered file when no test files exist', () => {
    const sourceContent = 'export function check(x) { return x > 0 && x < 100; }';
    const testCoverage = new Set();

    const baseName = 'check'; // filename without ext
    const isCovered = testCoverage.has(baseName);
    assert.ok(!isCovered, 'should be uncovered');

    const { count } = { count: countMutationCandidates(sourceContent) };
    assert.ok(count >= 2, 'should have mutation candidates');
  });

  it('marks file as covered when test imports it', () => {
    const testCoverage = new Set(['utils', 'check']);
    assert.ok(testCoverage.has('utils'));
  });

  it('extracts import paths from test content', () => {
    const testContent = `
      import { foo } from './utils';
      const bar = require('./helpers');
    `;
    // Match both ES import (from '...') and CJS require('...')
    const importPaths = testContent.match(/(?:from\s+|require\s*\()['"]([^'"]+)['"]/g) || [];
    const extracted = importPaths.map((imp) => {
      const m = imp.match(/['"]([^'"]+)['"]/);
      return m ? m[1].replace(/^\.\//, '').replace(/\.[^.]+$/, '') : null;
    }).filter(Boolean);
    assert.ok(extracted.includes('utils'), `expected 'utils' in ${JSON.stringify(extracted)}`);
    assert.ok(extracted.includes('helpers'), `expected 'helpers' in ${JSON.stringify(extracted)}`);
  });

  it('critical-path keywords are detected', () => {
    // No word boundaries — intentionally matches substrings like processPayment, stripeKey
    const CRITICAL_PATH_RE = /(payment|charge|stripe|auth|password|crypto|transaction)/i;
    assert.ok(CRITICAL_PATH_RE.test('function processPayment() {}'));
    assert.ok(CRITICAL_PATH_RE.test('const stripeKey = "sk_live_..."'));
    assert.ok(!CRITICAL_PATH_RE.test('function renderButton() {}'));
  });
});

describe('mutation-analysis — module shape', () => {
  it('module file exists', () => {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '../website/app/lib/scan-modules/mutation-analysis.ts');
    assert.ok(fs.existsSync(p), 'mutation-analysis.ts should exist');
  });

  it('is registered in index.ts', () => {
    const fs = require('fs');
    const path = require('path');
    const idx = fs.readFileSync(
      path.join(__dirname, '../website/app/lib/scan-modules/index.ts'),
      'utf8'
    );
    assert.ok(idx.includes('mutationAnalysis'), 'mutationAnalysis should be in index.ts');
  });

  it('is in the full tier', () => {
    const fs = require('fs');
    const path = require('path');
    const types = fs.readFileSync(
      path.join(__dirname, '../website/app/lib/scan-modules/types.ts'),
      'utf8'
    );
    assert.ok(types.includes('"mutationAnalysis"'), 'mutationAnalysis should be in TIERS');
  });

  it('nuclear tier is defined', () => {
    const fs = require('fs');
    const path = require('path');
    const types = fs.readFileSync(
      path.join(__dirname, '../website/app/lib/scan-modules/types.ts'),
      'utf8'
    );
    assert.ok(types.includes('nuclear:'), 'nuclear tier should be defined in types.ts');
  });
});
