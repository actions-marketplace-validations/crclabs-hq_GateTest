/**
 * Phase 6.2.10 — performance benchmark generator.
 *
 * Sister to test-generator.js + property-test-generator.js. Where the
 * regression test catches "did this fix break the contract?" and the
 * property test catches "are there edge cases this test misses?", the
 * BENCHMARK answers "is this fix slower or faster than what it
 * replaced?".
 *
 * For every Nuclear-tier fix that touches what looks like a hot path
 * (loops, fetch chains, regex, DB query helpers), we ask Claude to
 * write a `tinybench` micro-benchmark file that:
 *   1. Imports BOTH the original and fixed function
 *   2. Runs each through 1000+ iterations
 *   3. Outputs a side-by-side mean/p95/min/max comparison
 *
 * The customer runs the benchmark locally and pastes the result into
 * the PR comment, OR they look at the tinybench output that the test
 * runner emits. Either way, the PR now carries proof that the fix is
 * not a perf regression.
 *
 * RELIABILITY CONTRACT (mirrors prior generators):
 *   - Per-fix failures NEVER block the underlying fix from shipping.
 *   - Hot-path heuristic — only generate benchmarks for sources that
 *     contain at least one of: a loop, an `await`/Promise pattern,
 *     a regex literal, or a DB-shaped call. Every other source skips
 *     silently (no benchmark for a constants file).
 *   - JS/TS only today. Python perf-benchmarking via `pytest-benchmark`
 *     is a future sub-task.
 *   - Caps at maxFixes=5 to bound Claude spend.
 *
 * Pure / dependency-injected `askClaude` so tests run without network.
 */

const DEFAULT_MAX_FIXES = 5;
const TESTABLE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const NON_TESTABLE_PATHS = [
  /\.test\./,
  /\.spec\./,
  /\.snap$/,
  /\.d\.ts$/,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)tests?\//,
  /\.config\./,
  /\.json$/,
  /\.md$/,
  /\.gitignore$/,
  /\.env/,
  /^\./,
];

const HOT_PATH_PATTERNS = [
  /\bfor\s*\(/,           // for / for-of / for-in loops
  /\bwhile\s*\(/,
  /\.forEach\s*\(/,
  /\.map\s*\(/,
  /\.reduce\s*\(/,
  /\bawait\b/,
  /\.then\s*\(/,
  /new\s+RegExp\b/,
  /\/[^/\n]+\/[gimsuy]*[\s.,;)]/, // regex literal followed by terminator
  /\bfetch\s*\(/,
  /\.query\s*\(/,
  /\.findOne\s*\(/,
  /\.findMany\s*\(/,
  /\.find\s*\(/,
  /\bdb\./,
  /\bprisma\./,
  /\bsequelize\./,
];

/**
 * Quick "does this look like a hot path?" check. False-positive friendly
 * (better to generate a benchmark Claude will refuse via SKIP than to
 * miss a real perf-relevant fix). False-negative-tolerant (constants
 * files / pure type definitions correctly produce nothing).
 */
function looksLikeHotPath(fixedContent) {
  if (typeof fixedContent !== 'string' || fixedContent.length === 0) return false;
  for (const pat of HOT_PATH_PATTERNS) {
    if (pat.test(fixedContent)) return true;
  }
  return false;
}

/**
 * Fix is benchmarkable when:
 *   - source extension is JS/TS family
 *   - file is not a test / config / doc / dotfile
 *   - both `original` and `fixed` are non-empty (CREATE_FILE excluded)
 *   - `fixed` contains at least one hot-path signal
 */
function isBenchmarkableFix(fix) {
  if (!fix || typeof fix.file !== 'string') return false;
  if (!fix.fixed || typeof fix.fixed !== 'string') return false;
  if (!fix.original || fix.original === '') return false;
  const lower = fix.file.toLowerCase();
  for (const pattern of NON_TESTABLE_PATHS) {
    if (pattern.test(lower)) return false;
  }
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const ext = lower.slice(dotIdx + 1);
  if (!TESTABLE_EXTS.has(ext)) return false;
  return looksLikeHotPath(fix.fixed);
}

/**
 * Produce the benchmark filename for a given source path. Sits under
 * `tests/auto-generated/benchmarks/` so it's separate from the
 * regression-test + property-test surfaces but in the same auto-
 * generated tree the customer already knows about.
 */
function buildBenchmarkPath(sourcePath) {
  const ext = sourcePath.match(/\.(tsx?|mts|cts)$/i) ? 'ts' : 'js';
  const flat = sourcePath.replace(/^\/+/, '').replace(/\//g, '__').replace(/\.[^.]+$/, '');
  return `tests/auto-generated/benchmarks/${flat}.bench.${ext}`;
}

function buildBenchmarkPrompt({ filePath, originalContent, fixedContent, issues }) {
  return `You are writing a PERFORMANCE BENCHMARK that measures the impact of a
recent auto-fix on a hot-path function. The benchmark output will be
attached to the pull request as proof that the fix is not a perf
regression — and ideally evidence that it's a perf improvement.

FILE: ${filePath}
ISSUES THAT WERE FIXED:
${(issues || []).map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

ORIGINAL SOURCE (the version we're replacing):
\`\`\`
${originalContent}
\`\`\`

FIXED SOURCE (the version we're shipping):
\`\`\`
${fixedContent}
\`\`\`

REQUIREMENTS:
- Use the \`tinybench\` library (zero-config, no test-runner setup needed).
- Inline both the ORIGINAL and FIXED implementation as separate functions
  (rename them \`originalFn\` / \`fixedFn\`) so the benchmark runs without
  needing a real before/after import.
- Add a single suite with two cases — "original" and "fixed" — running
  on representative inputs. Use AT LEAST 2 inputs (small + large) so the
  benchmark surfaces complexity differences.
- Print the suite results to stdout with \`bench.tasks.forEach\` — include
  task name, mean (ns), p95, min, max. Customers paste this into the PR.
- Output ONLY the benchmark file content. No explanations. No markdown
  fences.
- If the fix does NOT touch a function whose performance can be measured
  (e.g. it's purely a config change, a comment fix, or a side-effect
  refactor with no return value to compare), output exactly:
  SKIP: <one-line reason>`;
}

/**
 * Generate a benchmark file for one fix. Returns the same shape as
 * the prior generators: { ok, path?, content?, sourceFile, skipped?, reason? }.
 */
async function generateBenchmarkForFix(opts) {
  const { fix, askClaudeForBench } = opts || {};
  if (!isBenchmarkableFix(fix)) {
    return {
      ok: false,
      skipped: true,
      reason: 'not benchmarkable (not a hot-path source or wrong extension)',
      sourceFile: fix?.file || null,
    };
  }
  if (typeof askClaudeForBench !== 'function') {
    return {
      ok: false,
      skipped: true,
      reason: 'no Claude wrapper supplied',
      sourceFile: fix.file,
    };
  }

  const prompt = buildBenchmarkPrompt({
    filePath: fix.file,
    originalContent: fix.original,
    fixedContent: fix.fixed,
    issues: fix.issues || [],
  });

  let raw;
  try {
    raw = await askClaudeForBench(prompt);
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: `Claude error: ${err && err.message ? err.message : String(err)}`,
      sourceFile: fix.file,
    };
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: 'empty Claude output',
      sourceFile: fix.file,
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
    };
  }

  const content = trimmed
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // Sanity: must reference tinybench AND must contain BOTH original
  // and fixed function names so the benchmark actually compares two
  // implementations rather than smoke-testing one.
  // Require either the tinybench import OR an actual `new Bench(` so a
  // comment like "// no Bench" doesn't accidentally pass the check.
  if (!/tinybench/.test(content) && !/\bnew\s+Bench\s*\(/.test(content)) {
    return {
      ok: false,
      skipped: true,
      reason: 'output did not import tinybench',
      sourceFile: fix.file,
    };
  }
  if (!/originalFn/.test(content) || !/fixedFn/.test(content)) {
    return {
      ok: false,
      skipped: true,
      reason: 'output did not include both originalFn and fixedFn',
      sourceFile: fix.file,
    };
  }

  return {
    ok: true,
    path: buildBenchmarkPath(fix.file),
    content,
    sourceFile: fix.file,
  };
}

/**
 * Generate benchmarks for a batch of fixes. Caps at maxFixes; sequential
 * because these calls are cheap and Anthropic doesn't reward parallelism
 * for single-shot prompts.
 */
async function generateBenchmarksForFixes(opts) {
  const { fixes, askClaudeForBench, maxFixes = DEFAULT_MAX_FIXES } = opts || {};
  if (!Array.isArray(fixes)) return { benchmarks: [], skipped: [], summary: 'no fixes provided' };
  if (typeof askClaudeForBench !== 'function') {
    return {
      benchmarks: [],
      skipped: fixes.map((f) => ({ sourceFile: f?.file || null, reason: 'no Claude wrapper' })),
      summary: 'no Claude wrapper provided',
    };
  }

  const benchmarks = [];
  const skipped = [];
  const sliced = fixes.slice(0, maxFixes);
  for (const fix of sliced) {
    const result = await generateBenchmarkForFix({ fix, askClaudeForBench });
    if (result.ok) {
      benchmarks.push({ path: result.path, content: result.content, sourceFile: result.sourceFile });
    } else {
      skipped.push({ sourceFile: result.sourceFile, reason: result.reason });
    }
  }

  const overflow = fixes.length - sliced.length;
  const summary = overflow > 0
    ? `Performance benchmarks: ${benchmarks.length} generated, ${skipped.length} skipped, ${overflow} additional fixes deferred (over ${maxFixes}-fix cap)`
    : `Performance benchmarks: ${benchmarks.length} generated, ${skipped.length} skipped`;
  return { benchmarks, skipped, summary };
}

module.exports = {
  DEFAULT_MAX_FIXES,
  TESTABLE_EXTS,
  HOT_PATH_PATTERNS,
  looksLikeHotPath,
  isBenchmarkableFix,
  buildBenchmarkPath,
  buildBenchmarkPrompt,
  generateBenchmarkForFix,
  generateBenchmarksForFixes,
};
