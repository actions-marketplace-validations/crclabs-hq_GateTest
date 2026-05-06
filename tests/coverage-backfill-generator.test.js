'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isBackfillable,
  hasCoverage,
  buildBackfillPath,
  buildBackfillPrompt,
  validateGeneratedTest,
  expectedTestPaths,
  generateBackfillForFile,
  generateCoverageBackfill,
  MAX_FILES_PER_RUN,
} = require('../website/app/lib/coverage-backfill-generator');

// ─── isBackfillable ──────────────────────────────────────────────────────────

describe('isBackfillable', () => {
  it('accepts ordinary JS source files', () => {
    assert.equal(isBackfillable('src/utils.js'), true);
    assert.equal(isBackfillable('website/app/lib/foo.ts'), true);
    assert.equal(isBackfillable('src/helper.mjs'), true);
  });

  it('rejects test files', () => {
    assert.equal(isBackfillable('src/utils.test.js'), false);
    assert.equal(isBackfillable('src/utils.spec.ts'), false);
    assert.equal(isBackfillable('tests/foo.test.js'), false);
  });

  it('rejects type declarations', () => {
    assert.equal(isBackfillable('src/types.d.ts'), false);
  });

  it('rejects node_modules and dist', () => {
    assert.equal(isBackfillable('node_modules/lodash/index.js'), false);
    assert.equal(isBackfillable('dist/bundle.js'), false);
    assert.equal(isBackfillable('.next/server/app.js'), false);
  });

  it('rejects minified bundles', () => {
    assert.equal(isBackfillable('public/app.min.js'), false);
    assert.equal(isBackfillable('dist/lib.bundle.js'), false);
  });

  it('rejects bare barrel index files', () => {
    assert.equal(isBackfillable('src/index.js'), false);
    assert.equal(isBackfillable('src/index.ts'), false);
  });

  it('rejects non-JS/TS files', () => {
    assert.equal(isBackfillable('src/config.json'), false);
    assert.equal(isBackfillable('README.md'), false);
  });

  it('rejects empty / non-string', () => {
    assert.equal(isBackfillable(''), false);
    assert.equal(isBackfillable(null), false);
    assert.equal(isBackfillable(undefined), false);
  });
});

// ─── hasCoverage ─────────────────────────────────────────────────────────────

describe('hasCoverage', () => {
  it('returns true when a sibling .test.js exists', () => {
    const files = new Set(['src/utils.test.js']);
    assert.equal(hasCoverage('src/utils.js', files), true);
  });

  it('returns true when a sibling .spec.ts exists', () => {
    const files = new Set(['src/utils.spec.ts']);
    assert.equal(hasCoverage('src/utils.ts', files), true);
  });

  it('returns false when no test file exists', () => {
    const files = new Set(['src/other.test.js']);
    assert.equal(hasCoverage('src/utils.js', files), false);
  });

  it('returns true for auto-generated backfill path', () => {
    const files = new Set(['tests/auto-generated/src_utils.test.js']);
    assert.equal(hasCoverage('src/utils.js', files), true);
  });

  it('handles leading ./ in paths', () => {
    const files = new Set(['src/utils.test.js']);
    assert.equal(hasCoverage('./src/utils.js', files), true);
  });

  it('accepts Set or Array for existingTestFiles', () => {
    const arr = ['src/foo.test.js'];
    assert.equal(hasCoverage('src/foo.js', arr), true);
  });
});

// ─── buildBackfillPath ───────────────────────────────────────────────────────

describe('buildBackfillPath', () => {
  it('flattens slashes and appends .test.js', () => {
    const result = buildBackfillPath('website/app/lib/foo.ts');
    assert.equal(result, 'tests/auto-generated/backfill/website_app_lib_foo.test.js');
  });

  it('preserves .tsx extension for TSX files', () => {
    const result = buildBackfillPath('src/components/Button.tsx');
    assert.equal(result, 'tests/auto-generated/backfill/src_components_Button.test.tsx');
  });

  it('preserves .jsx extension for JSX files', () => {
    const result = buildBackfillPath('src/Modal.jsx');
    assert.equal(result, 'tests/auto-generated/backfill/src_Modal.test.jsx');
  });

  it('returns null for empty string', () => {
    assert.equal(buildBackfillPath(''), null);
    assert.equal(buildBackfillPath(null), null);
  });

  it('strips leading slashes', () => {
    const result = buildBackfillPath('/abs/path/to/mod.js');
    assert.equal(result, 'tests/auto-generated/backfill/abs_path_to_mod.test.js');
  });
});

// ─── buildBackfillPrompt ─────────────────────────────────────────────────────

describe('buildBackfillPrompt', () => {
  const content = 'exports.add = (a, b) => a + b;';

  it('includes filePath and content', () => {
    const prompt = buildBackfillPrompt('src/math.js', content, 'node:test');
    assert.ok(prompt.includes('src/math.js'));
    assert.ok(prompt.includes(content));
  });

  it('mentions node:test framework', () => {
    const prompt = buildBackfillPrompt('src/math.js', content, 'node:test');
    assert.ok(prompt.includes('node:test') || prompt.includes("node:assert"));
  });

  it('mentions jest when requested', () => {
    const prompt = buildBackfillPrompt('src/math.js', content, 'jest');
    assert.ok(prompt.toLowerCase().includes('jest'));
  });

  it('mentions vitest when requested', () => {
    const prompt = buildBackfillPrompt('src/math.js', content, 'vitest');
    assert.ok(prompt.includes('vitest'));
  });

  it('asks to cover happy paths and edge cases', () => {
    const prompt = buildBackfillPrompt('src/math.js', content, 'node:test');
    assert.ok(prompt.includes('edge case') || prompt.includes('edge'));
    assert.ok(prompt.includes('happy path') || prompt.includes('happy'));
  });
});

// ─── validateGeneratedTest ───────────────────────────────────────────────────

describe('validateGeneratedTest', () => {
  it('accepts valid node:test output', () => {
    const content = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
describe('add', () => {
  it('adds two numbers', () => {
    assert.equal(add(1, 2), 3);
  });
});`;
    const { valid } = validateGeneratedTest(content, 'node:test');
    assert.equal(valid, true);
  });

  it('accepts valid jest output', () => {
    const content = `describe('foo', () => {
  test('works', () => { expect(foo()).toBe(1); });
});`;
    const { valid } = validateGeneratedTest(content, 'jest');
    assert.equal(valid, true);
  });

  it('rejects response that is too short', () => {
    const { valid, reason } = validateGeneratedTest('ok', 'node:test');
    assert.equal(valid, false);
    assert.ok(reason.includes('short'));
  });

  it('rejects response with no assertions', () => {
    const content = `import { describe } from 'node:test';
describe('foo', () => {
  it('runs', () => {
    const x = 1;
  });
});`;
    const { valid, reason } = validateGeneratedTest(content, 'node:test');
    assert.equal(valid, false);
    assert.ok(reason.includes('assertion'));
  });

  it('rejects empty content', () => {
    const { valid } = validateGeneratedTest('', 'node:test');
    assert.equal(valid, false);
  });
});

// ─── generateBackfillForFile ─────────────────────────────────────────────────

describe('generateBackfillForFile', () => {
  const validTestContent = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { add } = require('./src/math');
describe('add', () => {
  it('adds numbers', () => { assert.equal(add(1, 2), 3); });
});`;

  it('returns ok=true for valid Claude response', async () => {
    const result = await generateBackfillForFile({
      filePath: 'src/math.js',
      content: 'exports.add = (a, b) => a + b;',
      askClaude: async () => validTestContent,
      framework: 'node:test',
    });
    assert.equal(result.ok, true);
    assert.ok(result.test);
    assert.ok(result.test.path.includes('backfill'));
    assert.equal(result.test.sourceFile, 'src/math.js');
  });

  it('returns ok=false when Claude responds SKIP', async () => {
    const result = await generateBackfillForFile({
      filePath: 'src/db.js',
      content: 'const db = require("pg"); db.connect();',
      askClaude: async () => 'SKIP',
      framework: 'node:test',
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('not unit-testable'));
  });

  it('throws when Claude throws (propagates so orchestrator collects in errors[])', async () => {
    await assert.rejects(
      () => generateBackfillForFile({
        filePath: 'src/math.js',
        content: 'exports.add = (a, b) => a + b;',
        askClaude: async () => { throw new Error('API timeout'); },
        framework: 'node:test',
      }),
      /API timeout/
    );
  });

  it('strips code fences from Claude response', async () => {
    const fenced = '```javascript\n' + validTestContent + '\n```';
    const result = await generateBackfillForFile({
      filePath: 'src/math.js',
      content: 'exports.add = (a, b) => a + b;',
      askClaude: async () => fenced,
      framework: 'node:test',
    });
    assert.equal(result.ok, true);
    assert.ok(!result.test.content.startsWith('```'));
  });
});

// ─── generateCoverageBackfill ─────────────────────────────────────────────────

describe('generateCoverageBackfill', () => {
  const makeFile = (filePath, content = 'exports.fn = x => x;') => ({ filePath, content });

  const goodClaude = async () => `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
describe('fn', () => {
  it('returns input', () => { assert.equal(1, 1); });
});`;

  it('generates tests for uncovered files', async () => {
    const result = await generateCoverageBackfill({
      sourceFiles: [makeFile('src/utils.js')],
      existingTestFiles: [],
      askClaude: goodClaude,
    });
    assert.equal(result.tests.length, 1);
    assert.equal(result.totalGenerated, 1);
    assert.equal(result.errors.length, 0);
  });

  it('skips files that already have test coverage', async () => {
    const result = await generateCoverageBackfill({
      sourceFiles: [makeFile('src/utils.js')],
      existingTestFiles: new Set(['src/utils.test.js']),
      askClaude: goodClaude,
    });
    assert.equal(result.tests.length, 0);
    assert.ok(result.skipped.some(s => s.reason === 'no-uncovered-files'));
  });

  it('skips files that are not backfillable (test files, index.js)', async () => {
    const result = await generateCoverageBackfill({
      sourceFiles: [
        makeFile('src/utils.test.js'),
        makeFile('src/index.js'),
      ],
      existingTestFiles: [],
      askClaude: goodClaude,
    });
    assert.equal(result.tests.length, 0);
  });

  it('skips files larger than MAX_FILE_BYTES', async () => {
    const bigContent = 'x'.repeat(65 * 1024);
    const result = await generateCoverageBackfill({
      sourceFiles: [makeFile('src/big.js', bigContent)],
      existingTestFiles: [],
      askClaude: goodClaude,
    });
    assert.equal(result.tests.length, 0);
  });

  it('respects maxFiles cap and reports deferred in skipped', async () => {
    const files = Array.from({ length: 7 }, (_, i) => makeFile(`src/util${i}.js`));
    const result = await generateCoverageBackfill({
      sourceFiles: files,
      existingTestFiles: [],
      askClaude: goodClaude,
      maxFiles: 3,
    });
    assert.ok(result.tests.length <= 3);
    const deferred = result.skipped.find(s => s.reason && s.reason.startsWith('deferred:'));
    assert.ok(deferred, 'should have a deferred skip entry');
  });

  it('captures errors per-file without aborting the whole run', async () => {
    let calls = 0;
    const partialClaude = async () => {
      calls++;
      if (calls === 1) throw new Error('network fail');
      return `import { it } from 'node:test'; import assert from 'node:assert/strict';
it('x', () => { assert.equal(1,1); });`;
    };
    const result = await generateCoverageBackfill({
      sourceFiles: [makeFile('src/a.js'), makeFile('src/b.js')],
      existingTestFiles: [],
      askClaude: partialClaude,
    });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('network fail'));
  });

  it('exports MAX_FILES_PER_RUN constant', () => {
    assert.equal(typeof MAX_FILES_PER_RUN, 'number');
    assert.ok(MAX_FILES_PER_RUN > 0);
  });
});
