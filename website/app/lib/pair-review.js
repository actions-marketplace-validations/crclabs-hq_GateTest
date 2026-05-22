/**
 * Pair-review agent.
 *
 * Phase 2.1 of THE FIX-FIRST BUILD PLAN — first depth-deliverable that
 * justifies the $199 Scan + Fix tier over the $99 Full Scan tier.
 *
 * After the first Claude has produced a fix and a regression test, a
 * SECOND Claude reads the diff (original → fixed) and the new test
 * and writes a written critique on a fixed rubric:
 *
 *   - correctness    : does the fix actually address the issue?
 *   - completeness   : did it miss any aspect of the issue?
 *   - readability    : is the fix clear, idiomatic, well-named?
 *   - test coverage  : does the regression test demonstrate the bug
 *                      AND pass against the fix?
 *
 * Each axis scored 1-5 (1 = critical concern, 5 = clean). The agent
 * also produces a one-paragraph written critique. The combined output
 * lands as a PR comment so the customer sees a second pair of eyes
 * on every fix before they merge.
 *
 * Pure JS, dependency-injected. The route imports this and provides
 * `askClaudeForReview` (a thin wrapper around the existing Anthropic
 * call helper, modelled on askClaudeForTest from 1.3). Tests inject
 * a stub.
 *
 * Per-fix outcome:
 *   {
 *     file: string,
 *     ok: boolean,
 *     scores: { correctness, completeness, readability, testCoverage } | null,
 *     critique: string | null,
 *     reason: string | null,    // populated when ok=false
 *   }
 *
 * Failure modes are captured per-fix; one failure never aborts the
 * batch — a missing pair-review for one file is annoying but never
 * destructive.
 */

const { ANTI_INJECTION_PREAMBLE, wrapUntrusted, scanOutputForLeaks } = require('./prompt-injection-guard');

const REVIEW_AXES = ['correctness', 'completeness', 'readability', 'testCoverage'];

const SCORE_MIN = 1;
const SCORE_MAX = 5;

/**
 * Build the prompt for the pair-review agent. Exposed for tests so
 * the prompt shape can be asserted.
 */
function buildReviewPrompt({ filePath, originalContent, fixedContent, issues, testContent }) {
  const testSection = testContent
    ? `REGRESSION TEST (also added to the PR):\n${wrapUntrusted('test_content', testContent)}`
    : 'REGRESSION TEST: none was generated for this fix.';

  return `${ANTI_INJECTION_PREAMBLE}
You are the pair-review agent for GateTest. A first Claude agent already produced this fix in response to scanner findings. Your job is to read the diff and the regression test (if any) and write a critique.

DO NOT propose a different fix. DO NOT rewrite the code. Your output is a critique only — the customer reads it on their PR before merging.

Score each axis from 1 (critical concern) to 5 (clean):

  - correctness:    does the fix actually address the issue?
  - completeness:   did it miss any aspect of the issue or leave related cases unfixed?
  - readability:    is the fix clear, idiomatic, well-named?
  - testCoverage:   does the regression test demonstrate the bug AND pass against the fix?

FILE: ${wrapUntrusted('file_path', filePath)}

ISSUES THE FIX WAS MEANT TO ADDRESS:
${wrapUntrusted('issues', issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n'))}

ORIGINAL CODE:
${wrapUntrusted('original_code', originalContent)}

FIXED CODE:
${wrapUntrusted('fixed_code', fixedContent)}

${testSection}

Output format — STRICTLY this exact shape, no markdown fences, no preamble:

SCORES: correctness=N completeness=N readability=N testCoverage=N
CRITIQUE: <one paragraph, 2-4 sentences. Plain language. Note specific line numbers or symbols when possible.>

If you cannot review (the diff is empty, the file is config-only, you'd need to actually run the code) output exactly:
SKIP: <one-line reason>`;
}

/**
 * Parse the strict output shape of the review agent.
 * Returns either { ok: true, scores, critique } or { ok: false, reason }.
 */
function parseReviewOutput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'response was not a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty response' };

  // Refusal / SKIP marker
  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim() || 'reviewer declined';
    return { ok: false, reason: `reviewer declined: ${reason}` };
  }
  if (/^I (cannot|can't|won't)\b|^I'm unable to\b|^As an AI\b/.test(trimmed)) {
    return { ok: false, reason: 'reviewer refused' };
  }

  // Find the SCORES line
  const scoresLine = trimmed.match(/^SCORES:\s*(.+)$/m);
  if (!scoresLine) return { ok: false, reason: 'no SCORES line found' };
  const scoresText = scoresLine[1];

  const scores = {};
  for (const axis of REVIEW_AXES) {
    const m = scoresText.match(new RegExp(`${axis}\\s*=\\s*([1-5])\\b`, 'i'));
    if (!m) return { ok: false, reason: `missing score for ${axis}` };
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < SCORE_MIN || n > SCORE_MAX) {
      return { ok: false, reason: `invalid score for ${axis}: ${m[1]}` };
    }
    scores[axis] = n;
  }

  // Find the CRITIQUE block — everything after `CRITIQUE:` until end
  // or until a separator
  const critiqueMatch = trimmed.match(/CRITIQUE:\s*([\s\S]+?)$/m);
  if (!critiqueMatch) return { ok: false, reason: 'no CRITIQUE found' };
  const critique = critiqueMatch[1].trim();
  if (critique.length < 20) return { ok: false, reason: 'critique too short to be useful' };

  return { ok: true, scores, critique };
}

/**
 * Compute an overall summary from the per-fix reviews.
 */
function summariseReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { reviewed: 0, skipped: 0, averages: null, summary: 'pair review: no fixes to review' };
  }
  const reviewed = reviews.filter((r) => r.ok && r.scores);
  const skipped = reviews.filter((r) => !r.ok);

  if (reviewed.length === 0) {
    return {
      reviewed: 0,
      skipped: skipped.length,
      averages: null,
      summary: `pair review: 0 reviewed, ${skipped.length} skipped`,
    };
  }

  const averages = {};
  for (const axis of REVIEW_AXES) {
    const sum = reviewed.reduce((s, r) => s + r.scores[axis], 0);
    averages[axis] = Number((sum / reviewed.length).toFixed(2));
  }

  return {
    reviewed: reviewed.length,
    skipped: skipped.length,
    averages,
    summary: `pair review: ${reviewed.length} reviewed (avg correctness ${averages.correctness}/5, completeness ${averages.completeness}/5, readability ${averages.readability}/5, testCoverage ${averages.testCoverage}/5)${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
  };
}

/**
 * Run the pair-review agent against a single fix.
 *
 * @param {Object} opts
 * @param {{ file, original, fixed, issues }} opts.fix
 * @param {string} [opts.testContent]  Generated regression test source, if any.
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForReview
 * @returns {Promise<{
 *   file: string,
 *   ok: boolean,
 *   scores: { correctness, completeness, readability, testCoverage } | null,
 *   critique: string | null,
 *   reason: string | null,
 * }>}
 */
async function reviewSingleFix(opts) {
  const { fix, testContent, askClaudeForReview } = opts || {};
  if (!fix || typeof fix.file !== 'string') {
    return { file: '(unknown)', ok: false, scores: null, critique: null, reason: 'malformed fix entry' };
  }
  if (typeof askClaudeForReview !== 'function') {
    throw new TypeError('askClaudeForReview must be a function');
  }
  // CREATE_FILE — no original to diff against. Skip.
  if (typeof fix.original !== 'string' || fix.original.length === 0) {
    return { file: fix.file, ok: false, scores: null, critique: null, reason: 'no diff (new file)' };
  }
  if (!Array.isArray(fix.issues) || fix.issues.length === 0) {
    return { file: fix.file, ok: false, scores: null, critique: null, reason: 'no issues to review against' };
  }

  const prompt = buildReviewPrompt({
    filePath: fix.file,
    originalContent: fix.original,
    fixedContent: fix.fixed,
    issues: fix.issues,
    testContent,
  });

  let raw;
  try {
    raw = await askClaudeForReview(prompt);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { file: fix.file, ok: false, scores: null, critique: null, reason: `Claude API error: ${message}` };
  }

  const leakScan = scanOutputForLeaks(raw);
  if (!leakScan.safe) {
    const ids = leakScan.leaks.map((l) => l.id).join(', ');
    return { file: fix.file, ok: false, scores: null, critique: null, reason: `output suppressed — leak detected: ${ids}` };
  }
  raw = leakScan.redacted;

  const parsed = parseReviewOutput(raw);
  if (!parsed.ok) {
    return { file: fix.file, ok: false, scores: null, critique: null, reason: parsed.reason };
  }
  return { file: fix.file, ok: true, scores: parsed.scores, critique: parsed.critique, reason: null };
}

/**
 * Batch pair-review across a fix set.
 *
 * @param {Object} opts
 * @param {Array<{ file, original, fixed, issues }>} opts.fixes
 * @param {Map<string, string>|Record<string,string>} [opts.testsBySourceFile]
 *   Optional map from source file path → regression test content.
 *   If provided, each review sees the matching test content.
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForReview
 * @returns {Promise<{
 *   reviews: Array<{ file, ok, scores, critique, reason }>,
 *   averages: object | null,
 *   reviewed: number,
 *   skipped: number,
 *   summary: string,
 * }>}
 */
async function runPairReview(opts) {
  const { fixes, testsBySourceFile, askClaudeForReview } = opts || {};
  if (!Array.isArray(fixes)) throw new TypeError('fixes must be an array');
  if (typeof askClaudeForReview !== 'function') throw new TypeError('askClaudeForReview must be a function');

  // Normalise testsBySourceFile to a Map for clean lookups
  let testMap;
  if (testsBySourceFile instanceof Map) {
    testMap = testsBySourceFile;
  } else if (testsBySourceFile && typeof testsBySourceFile === 'object') {
    testMap = new Map(Object.entries(testsBySourceFile));
  } else {
    testMap = new Map();
  }

  // Skip auto-generated regression tests themselves — reviewing the
  // test the FIRST Claude wrote is a different task.
  const reviewables = fixes.filter((f) => !(f.file || '').startsWith('tests/auto-generated/'));

  const reviews = [];
  for (const fix of reviewables) {
    const testContent = testMap.get(fix.file);
    const result = await reviewSingleFix({ fix, testContent, askClaudeForReview });
    reviews.push(result);
  }

  const summary = summariseReviews(reviews);
  return {
    reviews,
    averages: summary.averages,
    reviewed: summary.reviewed,
    skipped: summary.skipped,
    summary: summary.summary,
  };
}

/**
 * Render the pair-review section as a markdown PR comment.
 */
function renderReviewComment(reviews, averages) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return '## GateTest Pair Review\n\nNo fixes were eligible for pair review.';
  }
  const lines = ['## GateTest Pair Review', ''];
  if (averages) {
    lines.push(
      `**Average scores** — correctness ${averages.correctness}/5 · completeness ${averages.completeness}/5 · readability ${averages.readability}/5 · test coverage ${averages.testCoverage}/5`
    );
    lines.push('');
  }
  for (const r of reviews) {
    if (r.ok && r.scores) {
      lines.push(`### \`${r.file}\``);
      lines.push('');
      lines.push(
        `Scores: correctness **${r.scores.correctness}**/5 · completeness **${r.scores.completeness}**/5 · readability **${r.scores.readability}**/5 · test coverage **${r.scores.testCoverage}**/5`
      );
      lines.push('');
      lines.push(`> ${r.critique.replace(/\n/g, '\n> ')}`);
      lines.push('');
    } else {
      lines.push(`### \`${r.file}\` — *not reviewed*`);
      lines.push('');
      lines.push(`_Reason: ${r.reason}_`);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('<sub>A second Claude agent reviewed each fix on a fixed rubric. This is part of the GateTest <a href="https://gatetest.ai">$199 Scan + Fix</a> tier — pair review is included with every fix PR.</sub>');
  return lines.join('\n');
}

module.exports = {
  runPairReview,
  reviewSingleFix,
  parseReviewOutput,
  buildReviewPrompt,
  summariseReviews,
  renderReviewComment,
  REVIEW_AXES,
};
