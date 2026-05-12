// ============================================================================
// INLINE-DIFF TEST — Phase 6.1.3 of THE 100-MOVES MASTER PLAN
// ============================================================================
// Pure-function coverage for the diff helper that powers DiffViewer +
// PR-composer diff embedding. Critical correctness properties:
//   - identical input/output ⇒ no hunks (no spurious diffs)
//   - line additions/removals correctly attributed
//   - hunks are 1-indexed (matches `diff -u`)
//   - oversize files fall back gracefully without OOM
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  MAX_LINES,
  CONTEXT_LINES,
  splitLines,
  diffLines,
  editsToHunks,
  computeInlineDiff,
  renderUnifiedDiff,
  summariseDiff,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'inline-diff.js'
));

// ---------- shape ----------

test('exports the constants the doc promises', () => {
  assert.strictEqual(typeof MAX_LINES, 'number');
  assert.ok(MAX_LINES >= 100);
  assert.strictEqual(typeof CONTEXT_LINES, 'number');
  assert.ok(CONTEXT_LINES >= 1);
});

// ---------- splitLines ----------

describe('splitLines', () => {
  it('returns empty array for non-string / empty input', () => {
    assert.deepStrictEqual(splitLines(null), []);
    assert.deepStrictEqual(splitLines(undefined), []);
    assert.deepStrictEqual(splitLines(42), []);
  });

  it('preserves single empty string as one empty line', () => {
    assert.deepStrictEqual(splitLines(''), ['']);
  });

  it('splits multi-line text without trailing empty line', () => {
    assert.deepStrictEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
    assert.deepStrictEqual(splitLines('a\nb\nc\n'), ['a', 'b', 'c']);
  });

  it('preserves intermediate empty lines', () => {
    assert.deepStrictEqual(splitLines('a\n\nb'), ['a', '', 'b']);
  });
});

// ---------- diffLines ----------

describe('diffLines', () => {
  it('identical input → all eq', () => {
    const edits = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.strictEqual(edits.every((e) => e.type === 'eq'), true);
    assert.strictEqual(edits.length, 3);
  });

  it('addition only', () => {
    const edits = diffLines(['a'], ['a', 'b']);
    assert.deepStrictEqual(edits.map((e) => e.type), ['eq', 'add']);
    assert.strictEqual(edits[1].text, 'b');
  });

  it('removal only', () => {
    const edits = diffLines(['a', 'b'], ['a']);
    assert.deepStrictEqual(edits.map((e) => e.type), ['eq', 'del']);
    assert.strictEqual(edits[1].text, 'b');
  });

  it('replacement (one line changed)', () => {
    const edits = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    const types = edits.map((e) => e.type);
    // Algorithm produces del+add OR add+del depending on tiebreak;
    // either way one of each shows up between the eqs.
    assert.strictEqual(types[0], 'eq');
    assert.strictEqual(types[types.length - 1], 'eq');
    assert.strictEqual(types.includes('del'), true);
    assert.strictEqual(types.includes('add'), true);
  });

  it('completely different input', () => {
    const edits = diffLines(['a', 'b'], ['x', 'y']);
    assert.strictEqual(edits.filter((e) => e.type === 'del').length, 2);
    assert.strictEqual(edits.filter((e) => e.type === 'add').length, 2);
  });
});

// ---------- editsToHunks ----------

describe('editsToHunks', () => {
  it('returns [] when there are no changes', () => {
    const edits = diffLines(['a', 'b'], ['a', 'b']);
    assert.deepStrictEqual(editsToHunks(edits), []);
  });

  it('produces 1-indexed line numbers (matches diff -u convention)', () => {
    const edits = diffLines(['a', 'b'], ['a', 'B']);
    const hunks = editsToHunks(edits, 1);
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].oldStart >= 1, true);
    assert.strictEqual(hunks[0].newStart >= 1, true);
  });

  it('respects contextLines parameter', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const newText = ['a', 'b', 'c', 'D', 'e', 'f', 'g'];
    const edits = diffLines(oldText, newText);
    // 0 context → just the change
    const zero = editsToHunks(edits, 0);
    const totalZero = zero.reduce((sum, h) => sum + h.lines.length, 0);
    // 3 context → change + up to 3 lines either side
    const three = editsToHunks(edits, 3);
    const totalThree = three.reduce((sum, h) => sum + h.lines.length, 0);
    assert.ok(totalThree > totalZero);
  });

  it('merges hunks within MAX_HUNK_GAP', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const newText = ['A', 'b', 'c', 'd', 'e', 'f', 'G'];
    const edits = diffLines(oldText, newText);
    const hunks = editsToHunks(edits, 5);
    // With 5 lines context, the two changes should merge into one hunk
    assert.strictEqual(hunks.length, 1);
  });
});

// ---------- computeInlineDiff ----------

describe('computeInlineDiff (the public entry-point)', () => {
  it('identical input → identical:true, hunks empty', () => {
    const r = computeInlineDiff('a\nb\nc', 'a\nb\nc');
    assert.strictEqual(r.identical, true);
    assert.deepStrictEqual(r.hunks, []);
  });

  it('empty input → identical:true', () => {
    const r = computeInlineDiff('', '');
    assert.strictEqual(r.identical, true);
  });

  it('detects single-line change', () => {
    const r = computeInlineDiff('a\nb\nc', 'a\nB\nc');
    assert.strictEqual(r.identical, false);
    assert.strictEqual(r.hunks.length, 1);
    const types = r.hunks[0].lines.map((l) => l.type);
    assert.ok(types.includes('add'));
    assert.ok(types.includes('remove'));
  });

  it('returns oversize:true when either side exceeds MAX_LINES', () => {
    const big = 'x\n'.repeat(MAX_LINES + 5);
    const r = computeInlineDiff(big, 'small');
    assert.strictEqual(r.oversize, true);
    assert.deepStrictEqual(r.hunks, []);
  });

  it('handles non-string input safely (no crash)', () => {
    const r = computeInlineDiff(null, null);
    assert.strictEqual(r.identical, true);
  });

  it('honors custom contextLines', () => {
    const r = computeInlineDiff('a\nb\nc', 'a\nB\nc', { contextLines: 0 });
    // No surrounding context — just the change
    const total = r.hunks.reduce((s, h) => s + h.lines.length, 0);
    assert.strictEqual(total, 2); // one remove + one add, no context
  });
});

// ---------- renderUnifiedDiff ----------

describe('renderUnifiedDiff', () => {
  it('empty hunks → empty string', () => {
    assert.strictEqual(renderUnifiedDiff({ hunks: [], identical: true, oversize: false }), '');
  });

  it('oversize → fallback message', () => {
    assert.match(renderUnifiedDiff({ hunks: [], identical: false, oversize: true }), /file too large/);
  });

  it('renders a complete unified diff with header + hunks', () => {
    const r = computeInlineDiff('a\nb\nc', 'a\nB\nc');
    const text = renderUnifiedDiff(r, { oldName: 'a/foo.js', newName: 'b/foo.js' });
    assert.match(text, /^--- a\/foo\.js/);
    assert.match(text, /\+\+\+ b\/foo\.js/);
    assert.match(text, /^@@ /m);
    assert.match(text, /^-b$/m);
    assert.match(text, /^\+B$/m);
  });

  it('uses default file names when none supplied', () => {
    const r = computeInlineDiff('a', 'b');
    const text = renderUnifiedDiff(r);
    assert.match(text, /^--- a\/file/);
    assert.match(text, /\+\+\+ b\/file/);
  });
});

// ---------- summariseDiff ----------

describe('summariseDiff', () => {
  it('"no changes" for identical', () => {
    const r = computeInlineDiff('a\nb', 'a\nb');
    assert.strictEqual(summariseDiff(r), '(no changes)');
  });

  it('"file too large" for oversize', () => {
    assert.match(summariseDiff({ hunks: [], identical: false, oversize: true }), /file too large/);
  });

  it('counts adds + removes + hunks', () => {
    const r = computeInlineDiff('a\nb\nc', 'a\nB\nc\nD');
    const s = summariseDiff(r);
    assert.match(s, /\d+ lines? added/);
    assert.match(s, /\d+ lines? removed/);
    assert.match(s, /\d+ hunks?/);
  });

  it('returns empty string for null input', () => {
    assert.strictEqual(summariseDiff(null), '');
  });
});

// ---------- determinism ----------

describe('determinism — same input → same output', () => {
  test('same input produces identical hunks every call', () => {
    const a = computeInlineDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    const b = computeInlineDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    assert.deepStrictEqual(a, b);
  });
});
