/**
 * Phase 6.2.7 — property-based test generator.
 *
 * Sister to test-generator.js. Where the unit-test generator writes a
 * SPECIFIC regression test ("calling fooBar(2,3) returns 5"), THIS
 * generator writes PROPERTY tests using fast-check (JS) or
 * hypothesis (Python) — invariants the function must satisfy under
 * thousands of random inputs.
 *
 * Why this matters: regression tests catch the bug we just fixed.
 * Property tests catch every NEIGHBOURING bug — edge cases, integer
 * overflows, off-by-one boundaries, empty inputs, unicode pathologies
 * — none of which Claude would think to write a unit test for.
 *
 * Real differentiator: no shipping competitor auto-generates
 * fast-check / hypothesis tests at fix time. This is the kind of
 * thing senior engineers write when they have time and most teams
 * don't have time.
 *
 * Pure / deterministic / dependency-injected `askClaude` so tests
 * run without the network.
 *
 * RELIABILITY CONTRACT:
 *   - Per-fix failures NEVER block the underlying fix from shipping.
 *     The fix already passed 3 gates and a regression test by the
 *     time we're called; a property test is bonus.
 *   - Same MAX_BYTES + skip-rules as test-generator.js to keep cost
 *     bounded.
 *   - Output filename: tests/auto-generated/<flat-source-path>.prop.<ext>
 *     so it sits alongside the regression test without colliding.
 */

const MAX_FIX_BYTES = 200 * 1024;
const NON_TESTABLE_PATHS = [
  /\.test\./,
  /\.spec\./,
  /\.snap$/,
  /\.d\.ts$/,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)tests?\//, // matches "tests/foo.ts" AND "src/tests/foo.ts"
  /\.config\./,
  /\.json$/,
  /\.md$/,
  /\.gitignore$/,
  /\.env/,
  /^\./,
];
const TESTABLE_EXTS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'py'];

function isPropTestableFix(fix) {
  if (!fix || typeof fix.file !== 'string') return false;
  if (!fix.fixed || typeof fix.fixed !== 'string') return false;
  if (fix.fixed === '' || fix.original === '') return false; // CREATE_FILE — skip
  if (fix.fixed.length > MAX_FIX_BYTES) return false;
  const lower = fix.file.toLowerCase();
  for (const pattern of NON_TESTABLE_PATHS) {
    if (pattern.test(lower)) return false;
  }
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const ext = lower.slice(dotIdx + 1);
  return TESTABLE_EXTS.includes(ext);
}

function detectLanguage(filePath) {
  const lower = (filePath || '').toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  return 'javascript';
}

function buildPropTestPath(sourcePath) {
  const ext = sourcePath.toLowerCase().endsWith('.py')
    ? 'py'
    : sourcePath.match(/\.(tsx?|mts|cts)$/i)
      ? 'ts'
      : 'js';
  // tests/auto-generated/<flattened>.prop.<ext>
  const flat = sourcePath.replace(/^\/+/, '').replace(/\//g, '__').replace(/\.[^.]+$/, '');
  return `tests/auto-generated/${flat}.prop.${ext}`;
}

/**
 * Build the prompt for Claude. Different prompts per language so the
 * model knows which library to import and which idioms to use.
 */
function buildPropTestPrompt({ filePath, fixedContent, issues, language }) {
  if (language === 'python') {
    return `You are writing PROPERTY-BASED tests for code that was just auto-fixed.
The goal is invariants the function must always satisfy across thousands of
random inputs — not specific input/output examples.

FILE: ${filePath}
ISSUES THAT WERE FIXED:
${(issues || []).map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

FIXED CODE:
\`\`\`python
${fixedContent}
\`\`\`

REQUIREMENTS:
- Use the \`hypothesis\` library (already idiomatic for Python projects).
- Write 2-5 @given decorators that exercise the function under random
  inputs. Cover: type-shape invariants, idempotency, boundary cases
  (empty inputs, very large inputs, unicode, negative numbers).
- Each @given block must be a real assertion, not just a smoke test.
- Use @settings(max_examples=200) so the tests run fast.
- Import from the source file via a relative-import comment placeholder
  the customer can adjust: \`# from src.module import function\`
- Output ONLY the test file content. No explanations. No markdown fences.
- If the fixed code does not contain a function that's amenable to
  property testing (e.g. it's just a config value or class with no
  methods), output exactly:
  SKIP: <one-line reason>`;
  }
  // JavaScript / TypeScript
  return `You are writing PROPERTY-BASED tests for code that was just auto-fixed.
The goal is invariants the function must always satisfy across thousands of
random inputs — not specific input/output examples.

FILE: ${filePath}
ISSUES THAT WERE FIXED:
${(issues || []).map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

FIXED CODE:
\`\`\`
${fixedContent}
\`\`\`

REQUIREMENTS:
- Use the \`fast-check\` library (the JS standard for property testing).
- Use \`node:test\`'s describe/it for the test runner so it works without
  jest / vitest config.
- Write 2-5 fc.assert blocks. Cover: type-shape invariants, idempotency,
  boundary cases (empty arrays/strings, very large numbers, unicode,
  negatives). For pure functions, also include a "round-trip" property
  if applicable.
- Each property must be a real invariant assertion, not a smoke test.
- Use { numRuns: 200 } so each property executes within seconds.
- Import from the source file via a relative path placeholder the
  customer can adjust: \`// import { fn } from '../../src/path/to/file'\`
- Output ONLY the test file content. No explanations. No markdown fences.
- If the fixed code does not contain a function that's amenable to
  property testing (e.g. it's just a constant or React component), output
  exactly:
  SKIP: <one-line reason>`;
}

/**
 * Generate a property test for a single fix. Returns
 * { path, content, sourceFile } on success or { skipped, reason }
 * on the canned-skip path. ANY thrown error → caller's try/catch
 * decides; we never rethrow over Claude API errors.
 */
async function generatePropTestForFix(opts) {
  const { fix, askClaudeForTest } = opts || {};
  if (!isPropTestableFix(fix)) {
    return { skipped: true, sourceFile: fix?.file, reason: 'not property-testable' };
  }
  if (typeof askClaudeForTest !== 'function') {
    return { skipped: true, sourceFile: fix.file, reason: 'no Claude wrapper' };
  }

  const language = detectLanguage(fix.file);
  const prompt = buildPropTestPrompt({
    filePath: fix.file,
    fixedContent: fix.fixed,
    issues: fix.issues || [],
    language,
  });

  let raw;
  try {
    raw = await askClaudeForTest(prompt);
  } catch (err) {
    return {
      skipped: true,
      sourceFile: fix.file,
      reason: `Claude error: ${err && err.message ? err.message : String(err)}`,
    };
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { skipped: true, sourceFile: fix.file, reason: 'empty Claude output' };
  }

  const trimmed = raw.trim();
  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim();
    return { skipped: true, sourceFile: fix.file, reason: `model declined: ${reason || 'no reason given'}` };
  }

  // Strip any code fences Claude might add despite instructions.
  let content = trimmed
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // Sanity: must reference the property-testing lib for its language.
  if (language === 'python' && !/hypothesis|@given/.test(content)) {
    return { skipped: true, sourceFile: fix.file, reason: 'output did not import hypothesis' };
  }
  if (language === 'javascript' && !/fast-check|fc\.|fc\.assert/.test(content)) {
    return { skipped: true, sourceFile: fix.file, reason: 'output did not import fast-check' };
  }

  return {
    path: buildPropTestPath(fix.file),
    content,
    sourceFile: fix.file,
    language,
  };
}

/**
 * Generate property tests for a batch of fixes. Caps at maxFixes (so
 * a 50-file fix doesn't burn $5 of Claude credit on bonus tests). Each
 * fix runs sequentially to keep concurrency simple — these calls are
 * cheap and additive, no need to parallelise.
 */
async function generatePropTestsForFixes(opts) {
  const { fixes, askClaudeForTest, maxFixes = 8 } = opts || {};
  if (!Array.isArray(fixes)) return { tests: [], skipped: [], summary: 'no fixes provided' };
  if (typeof askClaudeForTest !== 'function') {
    return { tests: [], skipped: fixes.map((f) => ({ sourceFile: f?.file, reason: 'no Claude wrapper' })), summary: 'no Claude wrapper provided' };
  }

  const tests = [];
  const skipped = [];
  const sliced = fixes.slice(0, maxFixes);
  for (const fix of sliced) {
    const result = await generatePropTestForFix({ fix, askClaudeForTest });
    if (result.skipped) {
      skipped.push({ sourceFile: result.sourceFile, reason: result.reason });
    } else {
      tests.push({ path: result.path, content: result.content, sourceFile: result.sourceFile, language: result.language });
    }
  }

  const overflow = fixes.length - sliced.length;
  const summary = overflow > 0
    ? `Property tests: ${tests.length} generated, ${skipped.length} skipped, ${overflow} additional fixes deferred (over ${maxFixes}-fix cap)`
    : `Property tests: ${tests.length} generated, ${skipped.length} skipped`;
  return { tests, skipped, summary };
}

module.exports = {
  MAX_FIX_BYTES,
  NON_TESTABLE_PATHS,
  TESTABLE_EXTS,
  isPropTestableFix,
  detectLanguage,
  buildPropTestPath,
  buildPropTestPrompt,
  generatePropTestForFix,
  generatePropTestsForFixes,
};
