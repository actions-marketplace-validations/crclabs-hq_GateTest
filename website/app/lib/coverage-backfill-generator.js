/**
 * Phase 6.2.12 — test coverage backfill generator.
 *
 * The "already fine, just untested" problem: a codebase ships working
 * utility modules, data transformers, and business-logic helpers with zero
 * test files. When those modules eventually break, nobody knows until prod.
 * Writing tests after the fact is tedious — so developers don't.
 *
 * This module automates the backfill loop:
 *   1. Given a list of source files, filter to those with no associated
 *      test file and no obvious untestable shape (config, generated, type
 *      declarations).
 *   2. Ask Claude to write a comprehensive `node:test` suite covering
 *      every exported function — happy paths + edge cases.
 *   3. Sanity-check the response: must use the right test runner, must
 *      have actual assertions, must not be a bare smoke test.
 *   4. Return the generated test files as `{ path, content, sourceFile }`
 *      objects the caller can commit to the PR.
 *
 * Designed to run at Nuclear tier only — each source file costs one
 * Claude call, and a large repo can surface dozens of untested files.
 * Hard cap: MAX_FILES_PER_RUN.
 *
 * Dependency injection: `askClaude` is passed in so tests run offline.
 *
 * RELIABILITY CONTRACT:
 *   - Per-file failures are caught in errors[]; they never block other
 *     files from being processed.
 *   - Files that Claude declares untestable (SKIP) are surfaced in
 *     skipped[] as (info), not as failures.
 */

const MAX_FILES_PER_RUN = 5;
const MAX_FILE_BYTES = 60 * 1024; // 60KB — skip huge generated files

const TESTABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
]);

const SKIP_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.d\.ts$/,
  /(?:^|[/\\])__tests__[/\\]/,
  /(?:^|[/\\])tests?[/\\]/,
  /(?:^|[/\\])node_modules[/\\]/,
  /(?:^|[/\\])dist[/\\]/,
  /(?:^|[/\\])build[/\\]/,
  /(?:^|[/\\])\.next[/\\]/,
  /(?:^|[/\\])coverage[/\\]/,
  /\.min\.[jt]sx?$/,
  /\.bundle\.[jt]sx?$/,
];

const SKIP_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.mjs',  // barrel files — usually thin re-exports
]);

/**
 * Check whether a source file is a candidate for backfilling.
 */
function isBackfillable(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const lower = filePath.toLowerCase();
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(lower)) return false;
  }
  const lastSlash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  const basename = lower.slice(lastSlash + 1);
  if (SKIP_BASENAMES.has(basename)) return false;
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return TESTABLE_EXTENSIONS.has(lower.slice(dotIdx));
}

/**
 * Derive the expected test-file path(s) for a given source file.
 * Returns an array of patterns to check against `existingTestFiles`.
 */
function expectedTestPaths(filePath) {
  const noExt = filePath.replace(/\.[^.]+$/, '');
  const paths = [];
  for (const ext of ['.test.js', '.test.ts', '.spec.js', '.spec.ts',
                     '.test.jsx', '.test.tsx', '.spec.jsx', '.spec.tsx']) {
    paths.push(noExt + ext);
    // Also check alongside the file in the same directory
    const lastSlash = Math.max(noExt.lastIndexOf('/'), noExt.lastIndexOf('\\'));
    const base = noExt.slice(lastSlash + 1);
    const dir = noExt.slice(0, lastSlash);
    paths.push(dir + '/__tests__/' + base + ext);
    paths.push(dir + '/tests/' + base + ext);
  }
  return paths;
}

/**
 * Determine whether a source file already has test coverage.
 *
 * @param {string} filePath
 * @param {Set<string>} existingTestFiles - normalised paths already in the repo
 */
function hasCoverage(filePath, existingTestFiles) {
  const testFileSet = existingTestFiles instanceof Set
    ? existingTestFiles
    : new Set(Array.from(existingTestFiles).map(p => p.replace(/\\/g, '/').replace(/^\.\//, '')));
  const normalised = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const candidate of expectedTestPaths(normalised)) {
    const c = candidate.replace(/^\.\//, '');
    if (testFileSet.has(c)) return true;
    // Also check the flattened auto-generated path (from test-generator.js)
    const noExt = c.replace(/\.[^.]+\.[jt]sx?$/, '');
    const flat = noExt.replace(/^\/+/, '').replace(/\//g, '_');
    if (testFileSet.has(`tests/auto-generated/${flat}.test.js`)) return true;
  }
  return false;
}

/**
 * Build the output path for the backfill test file.
 * Uses the same flattening convention as test-generator.js.
 */
function buildBackfillPath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) return null;
  const normalised = sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const dotIdx = normalised.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const ext = normalised.slice(dotIdx).toLowerCase();
  const testExt = ext === '.tsx' || ext === '.jsx' ? ext : '.js';
  const noExt = normalised.slice(0, dotIdx);
  const flattened = noExt.replace(/^\/+/, '').replace(/\//g, '_');
  return `tests/auto-generated/backfill/${flattened}.test${testExt}`;
}

/**
 * Build the Claude prompt for coverage backfill.
 */
function buildBackfillPrompt(filePath, content, framework) {
  const frameworkSection = framework === 'jest'
    ? 'TEST FRAMEWORK: Jest. Use `describe`, `test`/`it`, `expect`. No imports from vitest or node:test.'
    : framework === 'vitest'
    ? 'TEST FRAMEWORK: Vitest. Use `import { describe, test, expect } from "vitest"`.'
    : 'TEST FRAMEWORK: Node\'s built-in test runner. Use:\n  import { describe, it } from "node:test";\n  import assert from "node:assert/strict";\n  (or require equivalents for CJS)';

  return `You are writing a COMPREHENSIVE TEST SUITE for an untested source module.

${frameworkSection}

SOURCE FILE: ${filePath}

\`\`\`
${content}
\`\`\`

Your task:
1. Identify every EXPORTED function, class, or value in this module.
2. For each export, write tests covering:
   - The happy path (typical valid input → expected output)
   - At least one edge case per function (empty input, null/undefined, boundary values, type coercion)
   - Error paths where the function is documented to throw or return null/false
3. Keep tests self-contained — only import the module being tested and the test framework. No network, no file-system writes, no external services.
4. Use \`describe\` blocks to group tests by exported name.
5. DO NOT test implementation details or private (unexported) internals.
6. If the module has side-effects that make it untestable in isolation (e.g. it immediately connects to a DB on require, it launches a server), output the single token SKIP and nothing else.

Output ONLY the test file content. No markdown fences. No explanations. The very first line of your output must be the first line of the test file.`;
}

/**
 * Sanity-check Claude's generated test. Returns { valid, reason }.
 */
function validateGeneratedTest(content, framework) {
  if (!content || content.trim().length < 50) {
    return { valid: false, reason: 'response too short' };
  }
  // Must reference the framework
  const hasFramework = framework === 'jest'
    ? /\bexpect\b/.test(content)
    : framework === 'vitest'
    ? /from\s+['"]vitest['"]/.test(content)
    : /(?:node:test|node:assert|from\s+['"]node:)/.test(content);
  if (!hasFramework) {
    return { valid: false, reason: 'response does not use the expected test framework' };
  }
  // Must have actual assertions
  const hasAssertions = /assert\.|\.toBe\b|\.toEqual\b|\.toStrictEqual\b|\.toThrow\b|\.expect\b/.test(content);
  if (!hasAssertions) {
    return { valid: false, reason: 'response has no assertions' };
  }
  return { valid: true, reason: null };
}

/**
 * Strip code fences if Claude wrapped the output.
 */
function stripFences(text) {
  return text
    .replace(/^```[a-z]*\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
}

/**
 * Generate a backfill test file for a single source file.
 *
 * @param {Object} opts
 * @param {string} opts.filePath
 * @param {string} opts.content
 * @param {Function} opts.askClaude   async (prompt) => string
 * @param {string}   [opts.framework] 'jest'|'vitest'|'node:test'
 * @returns {Promise<{ ok, test, reason }>}
 */
async function generateBackfillForFile({ filePath, content, askClaude, framework = 'node:test' }) {
  const testPath = buildBackfillPath(filePath);
  if (!testPath) {
    return { ok: false, test: null, reason: 'could not build test path' };
  }

  const prompt = buildBackfillPrompt(filePath, content, framework);
  // Let Claude errors propagate so the orchestrator can put them in errors[].
  const raw = await askClaude(prompt);

  const trimmed = raw ? raw.trim() : '';
  if (trimmed === 'SKIP' || trimmed.startsWith('SKIP\n')) {
    return { ok: false, test: null, reason: 'Claude: module is not unit-testable in isolation' };
  }

  const testContent = stripFences(trimmed);
  const validation = validateGeneratedTest(testContent, framework);
  if (!validation.valid) {
    return { ok: false, test: null, reason: `validation failed: ${validation.reason}` };
  }

  return {
    ok: true,
    test: { path: testPath, content: testContent, sourceFile: filePath },
    reason: null,
  };
}

/**
 * Main entry point. Generate backfill tests for untested source files.
 *
 * @param {Object} opts
 * @param {Array<{ filePath: string, content: string }>} opts.sourceFiles
 *   All candidate source files (caller provides content).
 * @param {Set<string>|string[]} opts.existingTestFiles
 *   Paths of all test files already in the repo (for coverage detection).
 * @param {Function} opts.askClaude   async (prompt) => string
 * @param {string}   [opts.framework] 'jest'|'vitest'|'node:test'
 * @param {number}   [opts.maxFiles]  Override MAX_FILES_PER_RUN
 * @returns {Promise<{ tests, skipped, errors, totalGenerated }>}
 */
async function generateCoverageBackfill({
  sourceFiles = [],
  existingTestFiles = [],
  askClaude,
  framework = 'node:test',
  maxFiles = MAX_FILES_PER_RUN,
}) {
  const testFileSet = existingTestFiles instanceof Set
    ? existingTestFiles
    : new Set(Array.from(existingTestFiles).map(p => p.replace(/\\/g, '/').replace(/^\.\//, '')));

  const tests = [];
  const skipped = [];
  const errors = [];

  const allCandidates = sourceFiles.filter(({ filePath, content }) => {
    if (!isBackfillable(filePath)) return false;
    if (!content || content.length > MAX_FILE_BYTES) return false;
    if (hasCoverage(filePath, testFileSet)) return false;
    return true;
  });

  if (allCandidates.length === 0) {
    return { tests: [], skipped: [{ reason: 'no-uncovered-files' }], errors: [], totalGenerated: 0 };
  }

  if (allCandidates.length > maxFiles) {
    const deferred = allCandidates.length - maxFiles;
    skipped.push({ reason: `deferred: ${deferred} additional file(s) hit the per-run cap (${maxFiles}); re-run to process remaining` });
  }

  const candidates = allCandidates.slice(0, maxFiles);

  for (const { filePath, content } of candidates) {
    try {
      const result = await generateBackfillForFile({ filePath, content, askClaude, framework });
      if (result.ok && result.test) {
        tests.push(result.test);
      } else {
        skipped.push({ file: filePath, reason: result.reason || 'unknown' });
      }
    } catch (err) {
      errors.push(`generateBackfillForFile(${filePath}): ${err.message}`);
      skipped.push({ file: filePath, reason: 'error' });
    }
  }

  return { tests, skipped, errors, totalGenerated: tests.length };
}

module.exports = {
  generateCoverageBackfill,
  generateBackfillForFile,
  isBackfillable,
  hasCoverage,
  buildBackfillPath,
  buildBackfillPrompt,
  validateGeneratedTest,
  expectedTestPaths,
  MAX_FILES_PER_RUN,
};
