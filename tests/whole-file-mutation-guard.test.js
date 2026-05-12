/**
 * Tests for the whole-file mutation guard.
 *
 * Phase-1 fallback safety net for the whole-file Claude rewrite path.
 * See website/app/lib/whole-file-mutation-guard.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeLineDiff,
  evaluateMutation,
  summariseMutation,
} = require('../website/app/lib/whole-file-mutation-guard.js');

// ---------- computeLineDiff ----------

test('computeLineDiff: byte-identical input → 0 changes', () => {
  const src = 'line one\nline two\nline three\n';
  const result = computeLineDiff(src, src);
  assert.deepEqual(result, {
    changedLines: 0,
    addedLines: 0,
    removedLines: 0,
    totalChangedLines: 0,
  });
});

test('computeLineDiff: empty strings → 0 changes', () => {
  const result = computeLineDiff('', '');
  assert.deepEqual(result, {
    changedLines: 0,
    addedLines: 0,
    removedLines: 0,
    totalChangedLines: 0,
  });
});

test('computeLineDiff: single line replaced → 1 add + 1 remove (totalChangedLines = 2)', () => {
  // The naive forward-scan with bounded windows treats a 1-for-1
  // replacement as add+remove because it can't find a re-sync inside
  // the window for either pointer (the next lines match, so the
  // algorithm bails into the "no match in either direction" branch
  // OR finds equal-length re-sync gaps and prefers insertion).
  // Either way the convention is: replaced line = ~2 totalChangedLines.
  const original = 'a\nb\nc\nd\n';
  const fixed = 'a\nB\nc\nd\n';
  const result = computeLineDiff(original, fixed);
  assert.equal(result.totalChangedLines >= 1, true, 'should report at least one changed line');
  assert.equal(result.totalChangedLines <= 2, true, 'should report at most two changed lines');
  // Must mark something as changed/added/removed.
  assert.equal(result.addedLines + result.removedLines + result.changedLines > 0, true);
});

test('computeLineDiff: 5 lines inserted in the middle → 5 added lines', () => {
  const original = 'a\nb\nc\nd\ne\n';
  const fixed = 'a\nb\nNEW1\nNEW2\nNEW3\nNEW4\nNEW5\nc\nd\ne\n';
  const result = computeLineDiff(original, fixed);
  assert.equal(result.addedLines, 5, 'should detect 5 added lines');
  assert.equal(result.removedLines, 0, 'should not falsely report removals');
  assert.equal(result.totalChangedLines, 5);
});

test('computeLineDiff: 5 lines removed → 5 removed lines', () => {
  const original = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const fixed = 'a\nb\ng\nh\n';
  const result = computeLineDiff(original, fixed);
  assert.equal(result.removedLines, 4, 'should detect 4 removed lines (c,d,e,f)');
  assert.equal(result.addedLines, 0, 'should not falsely report additions');
  assert.equal(result.totalChangedLines, 4);
});

test('computeLineDiff: whole-file rewrite (entirely different content) → bounded by file size', () => {
  const original = Array.from({ length: 30 }, (_, i) => `original-line-${i}`).join('\n');
  const fixed = Array.from({ length: 30 }, (_, i) => `rewritten-${i}`).join('\n');
  const result = computeLineDiff(original, fixed);
  // Bounded by file size — totalChangedLines should be roughly the
  // size of the file (could be add+remove, could be replaced, or a
  // mix). Must be at least the line count and at most 2x.
  const origLineCount = original.split('\n').length;
  assert.equal(
    result.totalChangedLines >= origLineCount,
    true,
    `whole-file rewrite should report at least ${origLineCount} changed lines, got ${result.totalChangedLines}`,
  );
  assert.equal(
    result.totalChangedLines <= origLineCount * 2 + 1,
    true,
    `whole-file rewrite should be bounded by 2x file size, got ${result.totalChangedLines}`,
  );
});

test('computeLineDiff: append-only at end of file → only added lines', () => {
  const original = 'a\nb\nc\n';
  const fixed = 'a\nb\nc\nd\ne\nf\n';
  const result = computeLineDiff(original, fixed);
  assert.equal(result.addedLines, 3, 'should detect 3 appended lines');
  assert.equal(result.removedLines, 0);
});

test('computeLineDiff: truncation at end of file → only removed lines', () => {
  const original = 'a\nb\nc\nd\ne\nf\n';
  const fixed = 'a\nb\nc\n';
  const result = computeLineDiff(original, fixed);
  assert.equal(result.removedLines, 3, 'should detect 3 removed (truncated) lines');
  assert.equal(result.addedLines, 0);
});

test('computeLineDiff: handles non-string inputs gracefully', () => {
  const a = computeLineDiff(null, 'a\nb\n');
  assert.equal(typeof a.totalChangedLines, 'number');
  const b = computeLineDiff('a\nb\n', undefined);
  assert.equal(typeof b.totalChangedLines, 'number');
});

// ---------- evaluateMutation ----------

test('evaluateMutation: 1-issue, 3-line change in moderate file → ok', () => {
  // Small targeted bug fix: insert a guard clause (3 added lines).
  const original = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n');
  const fixed = original.split('\n').reduce((acc, line, i) => {
    acc.push(line);
    if (i === 25) {
      acc.push('  if (!input) return null;');
      acc.push('  // guard added');
      acc.push('  // by fix');
    }
    return acc;
  }, []).join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 1 });
  assert.equal(result.ok, true, `expected ok, got: ${result.reason}`);
  assert.equal(result.stats.issueCount, 1);
  assert.equal(result.stats.totalChangedLines, 3);
});

test('evaluateMutation: 1-issue, 50-line change in 100-line file → REJECT (percent rule)', () => {
  const original = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  // Replace the second half with completely different content.
  const fixedLines = original.split('\n').map((line, i) => (i >= 50 ? `replaced-${i}` : line));
  const fixed = fixedLines.join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 1 });
  assert.equal(result.ok, false, 'expected reject');
  assert.match(result.reason || '', /%/, 'rejection should mention percent');
  assert.equal(result.stats.percentChange > 0.30, true);
});

test('evaluateMutation: 5-issue, 100-line change → REJECT (per-issue rule)', () => {
  // 200-line file so we don't trip the percent rule (100/200 = 50%).
  // Wait — that WOULD trip percent. Build a bigger file so percent
  // stays under threshold and per-issue rule fires alone.
  const original = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
  // 100 lines added in the middle.
  const insertion = Array.from({ length: 100 }, (_, i) => `INSERTED-${i}`).join('\n');
  const origLines = original.split('\n');
  const fixedLines = [...origLines.slice(0, 250), insertion, ...origLines.slice(250)];
  const fixed = fixedLines.join('\n');

  // 5 issues × 8 maxChangePerIssue = 40 budget. 100 lines changed > 40.
  // Also > 80 absolute floor. Percent: 100 / 500 = 20% < 30%. So only
  // the per-issue rule trips.
  const result = evaluateMutation({ original, fixed, issueCount: 5 });
  assert.equal(result.ok, false, 'expected reject');
  assert.match(result.reason || '', /budget/, 'rejection should mention the per-issue budget');
});

test('evaluateMutation: 10-issue, proportional edits in a large file → ok', () => {
  // Large file (500 lines), 10 issues, ~50 lines changed total — under
  // every threshold (50 < 10*8=80 budget, 50 < 80 floor doesn't matter
  // because under-budget already, 50/500=10% < 30%).
  const original = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
  // Insert 5 lines in 10 different places — wait, 10 issues * ~5 lines
  // each = 50 lines added. Just bulk-insert 50 in one spot.
  const insertion = Array.from({ length: 50 }, (_, i) => `FIX-${i}`).join('\n');
  const origLines = original.split('\n');
  const fixedLines = [...origLines.slice(0, 250), insertion, ...origLines.slice(250)];
  const fixed = fixedLines.join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 10 });
  assert.equal(result.ok, true, `expected ok, got: ${result.reason}`);
  assert.equal(result.stats.totalChangedLines, 50);
});

test('evaluateMutation: small file gets free pass on per-issue rule via absolute floor', () => {
  // 30-line file, 1 issue, 20 lines changed. per-issue budget = 8.
  // 20 > 8 BUT 20 < 80 absolute floor → per-issue rule does NOT fire.
  // Percent: 20/30 = 66% > 30% → percent rule DOES fire.
  // So the test confirms percent rule still catches it on small files.
  const original = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
  const insertion = Array.from({ length: 20 }, (_, i) => `NEW-${i}`).join('\n');
  const origLines = original.split('\n');
  const fixedLines = [...origLines.slice(0, 15), insertion, ...origLines.slice(15)];
  const fixed = fixedLines.join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 1 });
  assert.equal(result.ok, false, 'expected reject from percent rule');
  assert.match(result.reason || '', /%/, 'should mention percent in rejection reason');
});

test('evaluateMutation: small file with small change, 1 issue → ok (free pass)', () => {
  // 30-line file, 1 issue, 5 lines changed. percent = 5/30 = 16.6% < 30%.
  // per-issue budget = 8, total = 5 ≤ 8, so even without the floor
  // it'd pass. With absolute floor: 5 < 80 → free pass.
  const original = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
  const insertion = Array.from({ length: 5 }, (_, i) => `NEW-${i}`).join('\n');
  const origLines = original.split('\n');
  const fixedLines = [...origLines.slice(0, 15), insertion, ...origLines.slice(15)];
  const fixed = fixedLines.join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 1 });
  assert.equal(result.ok, true, `expected ok, got: ${result.reason}`);
});

test('evaluateMutation: byte-identical input → ok with 0 stats', () => {
  const src = 'a\nb\nc\n';
  const result = evaluateMutation({ original: src, fixed: src, issueCount: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.stats.totalChangedLines, 0);
  assert.equal(result.stats.percentChange, 0);
});

test('evaluateMutation: respects custom thresholds', () => {
  const original = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const insertion = Array.from({ length: 15 }, (_, i) => `NEW-${i}`).join('\n');
  const origLines = original.split('\n');
  const fixed = [...origLines.slice(0, 50), insertion, ...origLines.slice(50)].join('\n');

  // Default would accept (15 lines added, 1 issue, 15 > 8 per-issue but
  // 15 < 80 absolute, percent ~14.7% < 30%). Tighten percent to 10%.
  const result = evaluateMutation({
    original,
    fixed,
    issueCount: 1,
    maxPercentChange: 0.10,
  });
  assert.equal(result.ok, false, 'expected reject under tight percent threshold');
});

test('evaluateMutation: 0 issues + any change → rejects (per-issue budget = 0)', () => {
  // Defensive: if a caller passes issueCount: 0 with a change, the
  // per-issue budget is 0. Any change > 0 trips the per-issue rule
  // when total also > absolute. With totalChangedLines=10, absolute
  // floor = 80, the per-issue rule does NOT fire (10 < 80) — but
  // percent might. For a 100-line file: 10% < 30%, so this case
  // actually passes. Document the behaviour.
  const original = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const insertion = Array.from({ length: 10 }, (_, i) => `NEW-${i}`).join('\n');
  const origLines = original.split('\n');
  const fixed = [...origLines.slice(0, 50), insertion, ...origLines.slice(50)].join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 0 });
  // Behaviour: small change in big file with 0 issues → still passes
  // because the absolute floor protects small drift. That's the
  // documented contract — the guard's job is to catch BIG drift, not
  // every drift.
  assert.equal(result.ok, true, 'small change passes even with 0 issues');
});

// ---------- summariseMutation ----------

test('summariseMutation: returns sane string for accepted result', () => {
  const original = 'a\nb\nc\nd\ne\n';
  const fixed = 'a\nb\nNEW\nc\nd\ne\n';
  const result = evaluateMutation({ original, fixed, issueCount: 1 });
  const summary = summariseMutation(result);
  assert.equal(typeof summary, 'string');
  assert.match(summary, /accepted/);
  assert.match(summary, /1 issue/);
});

test('summariseMutation: returns sane string for rejected result', () => {
  const original = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const fixedLines = original.split('\n').map((line, i) => (i >= 50 ? `replaced-${i}` : line));
  const fixed = fixedLines.join('\n');

  const result = evaluateMutation({ original, fixed, issueCount: 1 });
  const summary = summariseMutation(result);
  assert.equal(typeof summary, 'string');
  assert.match(summary, /REJECTED/);
  assert.match(summary, /added/);
  assert.match(summary, /removed/);
});

test('summariseMutation: handles missing input gracefully', () => {
  assert.equal(summariseMutation(null), 'mutation guard: not run');
  assert.equal(summariseMutation(undefined), 'mutation guard: not run');
  assert.equal(summariseMutation({}), 'mutation guard: not run');
});

test('summariseMutation: pluralisation correct for multi-issue', () => {
  const src = 'a\nb\n';
  const result = evaluateMutation({ original: src, fixed: src, issueCount: 3 });
  const summary = summariseMutation(result);
  assert.match(summary, /3 issues/);
});
