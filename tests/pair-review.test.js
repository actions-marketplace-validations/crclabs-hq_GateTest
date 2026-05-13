// ============================================================================
// PAIR-REVIEW TEST — Phase 2.1 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/pair-review.js — the second-Claude critique
// agent that justifies the $199 Scan+Fix tier over the $99 tier. Reads
// (original → fixed) diff + regression test, scores 4 axes, writes a
// paragraph critique. Output lands as a PR comment.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  runPairReview,
  reviewSingleFix,
  parseReviewOutput,
  buildReviewPrompt,
  summariseReviews,
  renderReviewComment,
  REVIEW_AXES,
} = require('../website/app/lib/pair-review.js');

const validReview = `SCORES: correctness=4 completeness=3 readability=5 testCoverage=4
CRITIQUE: The fix correctly addresses the null check on line 12 and the unused import. Completeness is solid although a related null check on line 27 could also use the new guard. Readability is excellent — the new helper name is clear.`;

const okFix = {
  file: 'src/foo.js',
  original: 'function buggy() { return null; }',
  fixed: 'function fixed() { return 42; }',
  issues: ['returns null instead of 42'],
};

// ---------- buildReviewPrompt ----------

test('buildReviewPrompt — includes file path, both code blocks, all 4 axes', () => {
  const prompt = buildReviewPrompt({
    filePath: 'src/foo.js',
    originalContent: 'old',
    fixedContent: 'new',
    issues: ['issue A', 'issue B'],
    testContent: 'test code',
  });
  assert.match(prompt, /src\/foo\.js/);
  assert.match(prompt, /correctness/);
  assert.match(prompt, /completeness/);
  assert.match(prompt, /readability/);
  assert.match(prompt, /testCoverage/);
  assert.match(prompt, /1 \(critical concern\) to 5 \(clean\)/);
  assert.match(prompt, /issue A/);
  assert.match(prompt, /issue B/);
  assert.match(prompt, /test code/);
});

test('buildReviewPrompt — explicit instruction to NOT propose alternative fixes', () => {
  const prompt = buildReviewPrompt({
    filePath: 'a.js', originalContent: 'a', fixedContent: 'b', issues: ['x'],
  });
  assert.match(prompt, /DO NOT propose a different fix/);
  assert.match(prompt, /DO NOT rewrite the code/);
});

test('buildReviewPrompt — handles missing test content', () => {
  const prompt = buildReviewPrompt({
    filePath: 'a.js', originalContent: 'a', fixedContent: 'b', issues: ['x'],
  });
  assert.match(prompt, /none was generated/);
});

test('buildReviewPrompt — strict output shape documented', () => {
  const prompt = buildReviewPrompt({
    filePath: 'a.js', originalContent: 'a', fixedContent: 'b', issues: ['x'],
  });
  assert.match(prompt, /SCORES: correctness=N/);
  assert.match(prompt, /CRITIQUE:/);
  assert.match(prompt, /SKIP/);
});

// ---------- parseReviewOutput ----------

test('parseReviewOutput — happy path', () => {
  const result = parseReviewOutput(validReview);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scores, { correctness: 4, completeness: 3, readability: 5, testCoverage: 4 });
  assert.match(result.critique, /correctly addresses the null check/);
});

test('parseReviewOutput — SKIP marker', () => {
  const result = parseReviewOutput('SKIP: cannot review without running the test framework');
  assert.equal(result.ok, false);
  assert.match(result.reason, /reviewer declined.*cannot review/);
});

test('parseReviewOutput — bare SKIP token', () => {
  const result = parseReviewOutput('SKIP');
  assert.equal(result.ok, false);
  assert.match(result.reason, /declined/);
});

test('parseReviewOutput — refusal recognised', () => {
  const result = parseReviewOutput("I cannot review this because of safety concerns.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /refused/);
});

test('parseReviewOutput — empty / non-string', () => {
  assert.equal(parseReviewOutput('').ok, false);
  assert.equal(parseReviewOutput(null).ok, false);
  assert.equal(parseReviewOutput(undefined).ok, false);
  assert.equal(parseReviewOutput(42).ok, false);
});

test('parseReviewOutput — missing SCORES line', () => {
  const result = parseReviewOutput('CRITIQUE: This looks fine but I forgot the scores line.');
  assert.equal(result.ok, false);
  assert.match(result.reason, /no SCORES/);
});

test('parseReviewOutput — missing one axis score', () => {
  const result = parseReviewOutput('SCORES: correctness=4 completeness=3 readability=5\nCRITIQUE: ' + 'x'.repeat(50));
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing score for testCoverage/);
});

test('parseReviewOutput — out-of-range score', () => {
  const result = parseReviewOutput('SCORES: correctness=7 completeness=3 readability=5 testCoverage=4\nCRITIQUE: ' + 'x'.repeat(50));
  // 7 fails the [1-5] regex match — reported as missing
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing score for correctness/);
});

test('parseReviewOutput — missing CRITIQUE', () => {
  const result = parseReviewOutput('SCORES: correctness=4 completeness=3 readability=5 testCoverage=4');
  assert.equal(result.ok, false);
  assert.match(result.reason, /no CRITIQUE/);
});

test('parseReviewOutput — critique too short', () => {
  const result = parseReviewOutput('SCORES: correctness=4 completeness=3 readability=5 testCoverage=4\nCRITIQUE: ok');
  assert.equal(result.ok, false);
  assert.match(result.reason, /too short/);
});

// ---------- reviewSingleFix ----------

test('reviewSingleFix — happy path', async () => {
  const result = await reviewSingleFix({
    fix: okFix,
    askClaudeForReview: async () => validReview,
  });
  assert.equal(result.ok, true);
  assert.equal(result.file, 'src/foo.js');
  assert.deepEqual(result.scores, { correctness: 4, completeness: 3, readability: 5, testCoverage: 4 });
  assert.match(result.critique, /null check/);
});

test('reviewSingleFix — Claude API error captured', async () => {
  const result = await reviewSingleFix({
    fix: okFix,
    askClaudeForReview: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Claude API error: ECONNRESET/);
});

test('reviewSingleFix — CREATE_FILE (no original) skipped', async () => {
  let calls = 0;
  const result = await reviewSingleFix({
    fix: { file: 'new.js', original: '', fixed: 'new code', issues: ['create'] },
    askClaudeForReview: async () => { calls++; return validReview; },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no diff/);
});

test('reviewSingleFix — malformed fix entry', async () => {
  const result = await reviewSingleFix({
    fix: null,
    askClaudeForReview: async () => validReview,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /malformed/);
});

test('reviewSingleFix — input validation throws on missing askClaudeForReview', async () => {
  await assert.rejects(
    () => reviewSingleFix({ fix: okFix }),
    /askClaudeForReview must be a function/
  );
});

test('reviewSingleFix — passes test content into prompt', async () => {
  let promptSeen = '';
  await reviewSingleFix({
    fix: okFix,
    testContent: 'console.log("the test");',
    askClaudeForReview: async (p) => { promptSeen = p; return validReview; },
  });
  assert.match(promptSeen, /the test/);
});

// ---------- runPairReview (batch) ----------

test('runPairReview — batch with mixed outcomes', async () => {
  const fixes = [
    okFix,
    { file: 'src/bar.js', original: 'old', fixed: 'new', issues: ['fix bar'] },
    { file: 'src/new.js', original: '', fixed: 'newcode', issues: ['create'] }, // skipped
    { file: 'tests/auto-generated/src_foo.test.js', original: '', fixed: 't', issues: ['Regression test for src/foo.js'] }, // not reviewed
  ];
  const result = await runPairReview({
    fixes,
    askClaudeForReview: async () => validReview,
  });
  // 2 reviewable + 1 skipped (new file) — auto-generated tests filtered out before review
  assert.equal(result.reviews.length, 3);
  assert.equal(result.reviewed, 2);
  assert.equal(result.skipped, 1);
  assert.match(result.summary, /2 reviewed.*1 skipped/);
  assert.deepEqual(result.averages, { correctness: 4, completeness: 3, readability: 5, testCoverage: 4 });
});

test('runPairReview — empty fix set', async () => {
  const result = await runPairReview({
    fixes: [],
    askClaudeForReview: async () => validReview,
  });
  assert.equal(result.reviews.length, 0);
  assert.equal(result.reviewed, 0);
  assert.match(result.summary, /no fixes/);
});

test('runPairReview — testsBySourceFile (Map) injected per-file', async () => {
  let promptsSeen = [];
  const fixes = [
    okFix,
    { file: 'src/bar.js', original: 'old', fixed: 'new', issues: ['fix bar'] },
  ];
  const tests = new Map([
    ['src/foo.js', '// foo test'],
    ['src/bar.js', '// bar test'],
  ]);
  await runPairReview({
    fixes,
    testsBySourceFile: tests,
    askClaudeForReview: async (p) => { promptsSeen.push(p); return validReview; },
  });
  assert.match(promptsSeen[0], /\/\/ foo test/);
  assert.match(promptsSeen[1], /\/\/ bar test/);
});

test('runPairReview — testsBySourceFile (object) accepted', async () => {
  let promptsSeen = [];
  await runPairReview({
    fixes: [okFix],
    testsBySourceFile: { 'src/foo.js': '// foo test (obj form)' },
    askClaudeForReview: async (p) => { promptsSeen.push(p); return validReview; },
  });
  assert.match(promptsSeen[0], /foo test \(obj form\)/);
});

test('runPairReview — Claude failure on one fix does not abort batch', async () => {
  let calls = 0;
  const fixes = [
    okFix,
    { file: 'src/bar.js', original: 'old', fixed: 'new', issues: ['fix bar'] },
    { file: 'src/baz.js', original: 'old', fixed: 'new', issues: ['fix baz'] },
  ];
  const result = await runPairReview({
    fixes,
    askClaudeForReview: async () => {
      calls++;
      if (calls === 2) throw new Error('transient API error');
      return validReview;
    },
  });
  assert.equal(result.reviewed, 2);
  assert.equal(result.skipped, 1);
});

test('runPairReview — input validation', async () => {
  await assert.rejects(
    () => runPairReview({ fixes: 'no', askClaudeForReview: async () => '' }),
    /fixes must be an array/
  );
  await assert.rejects(
    () => runPairReview({ fixes: [] }),
    /askClaudeForReview must be a function/
  );
});

// ---------- summariseReviews ----------

test('summariseReviews — empty', () => {
  const s = summariseReviews([]);
  assert.equal(s.reviewed, 0);
  assert.equal(s.skipped, 0);
  assert.match(s.summary, /no fixes/);
});

test('summariseReviews — averages computed across reviewed only', () => {
  const reviews = [
    { ok: true, scores: { correctness: 5, completeness: 5, readability: 5, testCoverage: 5 } },
    { ok: true, scores: { correctness: 3, completeness: 3, readability: 3, testCoverage: 3 } },
    { ok: false, reason: 'skipped' },
  ];
  const s = summariseReviews(reviews);
  assert.equal(s.reviewed, 2);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.averages, { correctness: 4, completeness: 4, readability: 4, testCoverage: 4 });
});

test('summariseReviews — all skipped', () => {
  const s = summariseReviews([
    { ok: false, reason: 'one' },
    { ok: false, reason: 'two' },
  ]);
  assert.equal(s.reviewed, 0);
  assert.equal(s.skipped, 2);
  assert.equal(s.averages, null);
});

// ---------- renderReviewComment ----------

test('renderReviewComment — empty', () => {
  assert.match(renderReviewComment([]), /No fixes were eligible/);
});

test('renderReviewComment — full markdown render', () => {
  const reviews = [
    { file: 'src/foo.js', ok: true, scores: { correctness: 4, completeness: 3, readability: 5, testCoverage: 4 }, critique: 'Looks good. The null check is correct.' },
    { file: 'src/bar.js', ok: false, reason: 'no diff (new file)' },
  ];
  const out = renderReviewComment(reviews, { correctness: 4, completeness: 3, readability: 5, testCoverage: 4 });
  assert.match(out, /## GateTest Pair Review/);
  assert.match(out, /Average scores/);
  assert.match(out, /correctness 4\/5/);
  assert.match(out, /\`src\/foo\.js\`/);
  assert.match(out, /correctness \*\*4\*\*\/5/);
  assert.match(out, /Looks good\. The null check/);
  assert.match(out, /\`src\/bar\.js\` — \*not reviewed\*/);
  assert.match(out, /no diff/);
  assert.match(out, /\$199/);
});

test('renderReviewComment — multiline critique blockquoted correctly', () => {
  const reviews = [
    { file: 'src/foo.js', ok: true, scores: { correctness: 5, completeness: 5, readability: 5, testCoverage: 5 }, critique: 'Line one of critique.\nLine two of critique.' },
  ];
  const out = renderReviewComment(reviews, null);
  assert.match(out, /> Line one of critique\./);
  assert.match(out, /> Line two of critique\./);
});

// ---------- REVIEW_AXES export ----------

test('REVIEW_AXES — exported and stable', () => {
  assert.deepEqual(REVIEW_AXES, ['correctness', 'completeness', 'readability', 'testCoverage']);
});
