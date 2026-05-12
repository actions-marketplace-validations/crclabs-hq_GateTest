/**
 * Phase 6.2.8 — mutation-driven test strengthener.
 *
 * After test-generator.js writes a regression test for a fix, this
 * helper takes the fixed source + the regression test, generates
 * mutation candidates against the source via the existing
 * `src/core/mutation-engine.js`, and asks Claude to evaluate whether
 * the test would CATCH each mutation. Mutations the test would miss
 * become the targets of a STRENGTHENED replacement test.
 *
 * Pattern: (regression test) + (mutation candidates) → Claude →
 * (strengthened test) — same shape as test-generator, just with
 * extra mutation context and an explicit ask for assertions covering
 * those mutations.
 *
 * Why this matters: a regression test that asserts only the happy
 * path can pass on the fixed code AND on a slightly-broken mutant.
 * The mutation engine flags those weak tests; this helper asks
 * Claude to add the missing assertions. Real differentiator:
 * Stryker / Pitest do mutation testing as a separate slow step;
 * we do it inline in the fix flow.
 *
 * RELIABILITY CONTRACT (mirrors test-generator + property-test-generator):
 *   - Per-fix failures NEVER block the underlying fix from shipping.
 *   - Skips fixes with no regression test or non-mutable source.
 *   - Per-language gates: only JS/TS strengthening today (Python's
 *     mutation engine is a different stack — punted to a future
 *     sub-task).
 *   - Caps mutations per file at 8 to bound prompt size + Claude
 *     spend.
 *
 * Pure / dependency-injected. Tests inject a fake-mutation-engine and
 * a fake-Claude.
 */

const DEFAULT_MAX_MUTATIONS_PER_FILE = 8;
const DEFAULT_MAX_FIXES = 5;
const TESTABLE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);

/**
 * Determine if a (fix, regressionTest) pair is eligible for
 * mutation-driven strengthening. Skips:
 *   - missing source / test
 *   - non-JS/TS sources (mutation engine is JS-only)
 *   - test files / dotfiles
 */
function isStrengthenable(fix, regressionTest) {
  if (!fix || typeof fix.fixed !== 'string' || fix.fixed.length === 0) return false;
  if (!regressionTest || typeof regressionTest.content !== 'string') return false;
  if (typeof fix.file !== 'string') return false;
  const dotIdx = fix.file.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const ext = fix.file.slice(dotIdx + 1).toLowerCase();
  if (!TESTABLE_EXTS.has(ext)) return false;
  return true;
}

/**
 * Format a mutation candidate as a single human-readable line for the
 * Claude prompt. Compact so we can fit ~8 per prompt without
 * blowing the context.
 */
function formatMutation(c) {
  if (!c) return '';
  const op = (c.mutation && c.mutation.name) || 'unknown';
  return `Line ${c.lineNumber} (${op}):\n  - ${c.original}\n  + ${c.mutated}`;
}

/**
 * Build the strengthening prompt. Tests reference this directly to
 * assert prompt shape.
 */
function buildStrengthenPrompt({ filePath, fixedContent, regressionTestContent, mutations }) {
  const mutationsBlock = mutations
    .slice(0, DEFAULT_MAX_MUTATIONS_PER_FILE)
    .map(formatMutation)
    .join('\n\n');
  return `You are STRENGTHENING a regression test by adding assertions that
catch mutations of the source code. The mutations below are subtle
changes that a weak test would silently allow to pass.

SOURCE FILE: ${filePath}
FIXED SOURCE:
\`\`\`
${fixedContent}
\`\`\`

CURRENT REGRESSION TEST:
\`\`\`
${regressionTestContent}
\`\`\`

MUTATIONS THE TEST MUST CATCH (each one is a single-line change to the
source — your strengthened test must FAIL on each mutation but PASS on
the fixed source):

${mutationsBlock}

REQUIREMENTS:
- Output the ENTIRE replacement test file. Do not output a diff.
- Keep the existing assertions that already pass — extend, don't rewrite.
- Add at least one new assertion per mutation that would distinguish
  fixed source from mutated source.
- Use the same test framework (node:test) as the input.
- Output ONLY the test file content. No explanations. No markdown fences.
- If NONE of the mutations would actually change observable behaviour
  (e.g. all mutations are inside a comment or string literal), output
  exactly:
  SKIP: <one-line reason>`;
}

/**
 * Strengthen one regression test against its fix's mutations.
 *
 * @param {object} opts
 * @param {object} opts.fix - { file, fixed, original, issues }
 * @param {object} opts.regressionTest - { path, content, sourceFile }
 * @param {Function} opts.askClaudeForStrengthen - injected Claude wrapper
 * @param {Function} [opts.generateMutations] - injectable for tests; defaults
 *   to require('../../../src/core/mutation-engine').generateMutations
 * @returns {Promise<{ ok, strengthenedContent?, mutationsChecked?, skipped?, reason?, sourceFile, testPath }>}
 */
async function strengthenRegressionTest(opts) {
  const {
    fix,
    regressionTest,
    askClaudeForStrengthen,
    generateMutations: genFn,
  } = opts || {};

  if (!isStrengthenable(fix, regressionTest)) {
    return {
      ok: false,
      skipped: true,
      reason: 'fix or test not eligible for strengthening',
      sourceFile: fix?.file || null,
      testPath: regressionTest?.path || null,
    };
  }
  if (typeof askClaudeForStrengthen !== 'function') {
    return {
      ok: false,
      skipped: true,
      reason: 'no Claude wrapper supplied',
      sourceFile: fix.file,
      testPath: regressionTest.path,
    };
  }

  // Use the inlined mutation generator unless a test injects an override.
  // We inline rather than import from src/core/ because Turbopack locks
  // the website to its own directory tree (next.config.ts: turbopack.root).
  const mutationFn = genFn || generateMutationsInline;

  let mutations;
  try {
    mutations = mutationFn(fix.fixed, { maxPerFile: DEFAULT_MAX_MUTATIONS_PER_FILE });
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: `mutation engine error: ${err && err.message ? err.message : 'unknown'}`,
      sourceFile: fix.file,
      testPath: regressionTest.path,
    };
  }
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: 'no mutation candidates (source may be too short or all-comments)',
      sourceFile: fix.file,
      testPath: regressionTest.path,
    };
  }

  const prompt = buildStrengthenPrompt({
    filePath: fix.file,
    fixedContent: fix.fixed,
    regressionTestContent: regressionTest.content,
    mutations,
  });

  let raw;
  try {
    raw = await askClaudeForStrengthen(prompt);
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: `Claude error: ${err && err.message ? err.message : String(err)}`,
      sourceFile: fix.file,
      testPath: regressionTest.path,
      mutationsChecked: mutations.length,
    };
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: 'empty Claude output',
      sourceFile: fix.file,
      testPath: regressionTest.path,
      mutationsChecked: mutations.length,
    };
  }

  const trimmed = raw.trim();
  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim();
    return {
      ok: false,
      skipped: true,
      reason: `model declined: ${reason || 'no reason given'}`,
      sourceFile: fix.file,
      testPath: regressionTest.path,
      mutationsChecked: mutations.length,
    };
  }

  // Strip Claude-added markdown fences.
  const content = trimmed
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // Sanity: strengthened content must NOT be byte-identical to input
  // (otherwise no strengthening happened) AND must include at least
  // one assertion-shaped expression.
  if (content === regressionTest.content.trim()) {
    return {
      ok: false,
      skipped: true,
      reason: 'Claude returned identical content — no strengthening applied',
      sourceFile: fix.file,
      testPath: regressionTest.path,
      mutationsChecked: mutations.length,
    };
  }
  if (!/assert|expect|toBe|toEqual|notEqual/.test(content)) {
    return {
      ok: false,
      skipped: true,
      reason: 'output had no recognisable assertion calls',
      sourceFile: fix.file,
      testPath: regressionTest.path,
      mutationsChecked: mutations.length,
    };
  }

  return {
    ok: true,
    strengthenedContent: content,
    mutationsChecked: mutations.length,
    sourceFile: fix.file,
    testPath: regressionTest.path,
  };
}

/**
 * Strengthen every regression test in a batch. Caps at maxFixes so a
 * 50-file fix doesn't burn $5 of bonus Claude credit. Each fix runs
 * sequentially — these calls are cheap and additive.
 *
 * Returns:
 *   {
 *     strengthened: [{ path, content, sourceFile, mutationsChecked }],
 *     skipped: [{ sourceFile, testPath, reason }],
 *     summary: string,
 *   }
 *
 * Caller writes the strengthened test back into `fixes` (replacing the
 * original test entry by path).
 */
async function strengthenRegressionTests(opts) {
  const {
    fixes,
    regressionTests,
    askClaudeForStrengthen,
    maxFixes = DEFAULT_MAX_FIXES,
    generateMutations: genFn,
  } = opts || {};

  if (!Array.isArray(fixes) || !Array.isArray(regressionTests) || regressionTests.length === 0) {
    return { strengthened: [], skipped: [], summary: 'no regression tests to strengthen' };
  }
  if (typeof askClaudeForStrengthen !== 'function') {
    return {
      strengthened: [],
      skipped: regressionTests.map((t) => ({
        sourceFile: t.sourceFile, testPath: t.path, reason: 'no Claude wrapper',
      })),
      summary: 'no Claude wrapper provided',
    };
  }

  // Build a map: sourceFile → fix so we can pair tests to their fix.
  const fixByFile = new Map();
  for (const f of fixes) {
    if (f && f.file) fixByFile.set(f.file, f);
  }

  const strengthened = [];
  const skipped = [];
  const sliced = regressionTests.slice(0, maxFixes);
  for (const test of sliced) {
    const fix = fixByFile.get(test.sourceFile);
    if (!fix) {
      skipped.push({
        sourceFile: test.sourceFile, testPath: test.path,
        reason: 'no matching fix for this regression test',
      });
      continue;
    }
    const result = await strengthenRegressionTest({
      fix, regressionTest: test, askClaudeForStrengthen, generateMutations: genFn,
    });
    if (result.ok) {
      strengthened.push({
        path: test.path,
        content: result.strengthenedContent,
        sourceFile: test.sourceFile,
        mutationsChecked: result.mutationsChecked,
      });
    } else {
      skipped.push({
        sourceFile: test.sourceFile,
        testPath: test.path,
        reason: result.reason,
        mutationsChecked: result.mutationsChecked,
      });
    }
  }

  const overflow = regressionTests.length - sliced.length;
  const summary = overflow > 0
    ? `Mutation strengthening: ${strengthened.length} strengthened, ${skipped.length} skipped, ${overflow} additional tests deferred (over ${maxFixes}-test cap)`
    : `Mutation strengthening: ${strengthened.length} strengthened, ${skipped.length} skipped`;
  return { strengthened, skipped, summary };
}

// ----------------------------------------------------------------------
// Inlined mutation generator — minimal subset of src/core/mutation-engine.js
// kept in the website tree so Turbopack (root-locked to /website) can
// resolve it. Operates on JS/TS source line-by-line. The CLI keeps its
// own richer copy at src/core/mutation-engine.js for `gatetest --suite
// nuclear`. If you change the operator list here, change it there too.
// ----------------------------------------------------------------------
const INLINE_OPERATORS = [
  { name: 'eq-flip', match: /===/, replace: '!==' },
  { name: 'neq-flip', match: /!==/, replace: '===' },
  { name: 'gt-to-lt', match: /(\W)>(\W)/, replace: '$1<$2' },
  { name: 'lt-to-gt', match: /(\W)<(\W)/, replace: '$1>$2' },
  { name: 'add-to-sub', match: /(\W)\+(\W)/, replace: '$1-$2' },
  { name: 'sub-to-add', match: /(\W)-(\W)/, replace: '$1+$2' },
  { name: 'true-to-false', match: /\btrue\b/, replace: 'false' },
  { name: 'false-to-true', match: /\bfalse\b/, replace: 'true' },
  { name: 'and-to-or', match: /&&/, replace: '||' },
  { name: 'or-to-and', match: /\|\|/, replace: '&&' },
  { name: 'inc-to-dec', match: /\+\+/, replace: '--' },
  { name: 'dec-to-inc', match: /--/, replace: '++' },
];

function shouldSkipLineInline(line) {
  if (typeof line !== 'string') return true;
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('*')) return true;
  if (trimmed.startsWith('/*')) return true;
  return false;
}

function generateMutationsInline(source, opts = {}) {
  if (typeof source !== 'string') return [];
  const maxPerFile = opts.maxPerFile || 50;
  const lines = source.split('\n');
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    if (candidates.length >= maxPerFile) break;
    const line = lines[i];
    if (shouldSkipLineInline(line)) continue;
    for (const op of INLINE_OPERATORS) {
      if (candidates.length >= maxPerFile) break;
      if (!op.match.test(line)) continue;
      const mutated = line.replace(op.match, op.replace);
      if (mutated === line) continue;
      candidates.push({
        lineNumber: i + 1,
        original: line,
        mutated,
        mutation: { name: op.name },
      });
      break; // one operator per line, keeps the candidate set diverse
    }
  }
  return candidates;
}

module.exports = {
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
  shouldSkipLineInline,
};
