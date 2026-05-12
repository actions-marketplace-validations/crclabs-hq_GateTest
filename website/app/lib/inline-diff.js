/**
 * Phase 6.1.3 — inline before/after diff helper.
 *
 * Pure functions that turn (originalContent, fixedContent) into a
 * compact set of hunks the UI can render side-by-side OR as a unified
 * diff. Used by:
 *   - The PR-composer to embed diffs in the markdown body
 *   - The DiffViewer React component on /scan/status (so $99 customers
 *     who don't get a PR can still SEE what the fix would change)
 *   - The AI-Builder Handoff "diff" export format
 *
 * No external diff library — small zero-dep LCS implementation. The
 * algorithm is line-based (no character-level intra-line diffs) which
 * is sufficient for fix-loop output where Claude usually rewrites
 * whole lines anyway.
 *
 * Output shape:
 *   { hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{ type, text }] }] }
 *   where type is 'context' | 'add' | 'remove'.
 *
 * Reliability contract:
 *   - Identical input/output ⇒ { hunks: [] } (no spurious hunks)
 *   - Bounded memory: caps at MAX_LINES per side; falls back to a
 *     "file too large for inline diff" sentinel
 *   - Always returns the same shape — caller never has to null-check
 */

const MAX_LINES = 5000; // line cap per side
const CONTEXT_LINES = 2; // lines of context around each change
const MAX_HUNK_GAP = 4; // merge hunks closer than this many context lines

/**
 * Split a string into lines preserving empty lines, no trailing
 * newline. Mirrors the standard diff convention.
 */
function splitLines(s) {
  if (typeof s !== 'string') return [];
  if (s === '') return [''];
  // Don't include the trailing empty line that comes from a final \n
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '' && s.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Standard LCS-based diff. Returns an array of edits:
 *   { type: 'eq' | 'del' | 'add', oldIndex?: number, newIndex?: number, text: string }
 * Edits are in the order they apply.
 *
 * O(n*m) time + memory — fine for ≤ MAX_LINES per side. Fall back
 * before this if either side exceeds the cap.
 */
function diffLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // Build LCS length table
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack to produce edit script
  const edits = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      edits.push({ type: 'eq', oldIndex: i, newIndex: j, text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      edits.push({ type: 'del', oldIndex: i, text: oldLines[i] });
      i++;
    } else {
      edits.push({ type: 'add', newIndex: j, text: newLines[j] });
      j++;
    }
  }
  while (i < n) { edits.push({ type: 'del', oldIndex: i, text: oldLines[i] }); i++; }
  while (j < m) { edits.push({ type: 'add', newIndex: j, text: newLines[j] }); j++; }
  return edits;
}

/**
 * Group consecutive non-equal edits into hunks with surrounding
 * context lines. Hunks closer than MAX_HUNK_GAP context lines apart
 * are merged into a single hunk.
 */
function editsToHunks(edits, contextLines = CONTEXT_LINES) {
  if (!Array.isArray(edits) || edits.length === 0) return [];

  // Find indices of every non-equal edit
  const changeIdxs = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'eq') changeIdxs.push(i);
  }
  if (changeIdxs.length === 0) return [];

  // Build hunk windows [start, end] over the edit array, including
  // up to `contextLines` of equal lines on each side.
  const windows = [];
  for (const idx of changeIdxs) {
    const wantStart = Math.max(0, idx - contextLines);
    const wantEnd = Math.min(edits.length - 1, idx + contextLines);
    const last = windows[windows.length - 1];
    if (last && wantStart <= last[1] + MAX_HUNK_GAP) {
      last[1] = Math.max(last[1], wantEnd);
    } else {
      windows.push([wantStart, wantEnd]);
    }
  }

  // Materialise each window as a hunk with line-number metadata.
  const hunks = [];
  for (const [start, end] of windows) {
    const slice = edits.slice(start, end + 1);
    let oldStart = null;
    let newStart = null;
    let oldLines = 0;
    let newLines = 0;
    const lines = [];
    for (const e of slice) {
      if (e.type === 'eq') {
        if (oldStart === null) oldStart = e.oldIndex;
        if (newStart === null) newStart = e.newIndex;
        oldLines++;
        newLines++;
        lines.push({ type: 'context', text: e.text });
      } else if (e.type === 'del') {
        if (oldStart === null) oldStart = e.oldIndex;
        oldLines++;
        lines.push({ type: 'remove', text: e.text });
      } else if (e.type === 'add') {
        if (newStart === null) newStart = e.newIndex;
        newLines++;
        lines.push({ type: 'add', text: e.text });
      }
    }
    // 1-indexed for human display (matches `diff -u` convention)
    hunks.push({
      oldStart: (oldStart ?? 0) + 1,
      oldLines,
      newStart: (newStart ?? 0) + 1,
      newLines,
      lines,
    });
  }
  return hunks;
}

/**
 * Top-level entry: turn (oldText, newText) into structured hunks.
 * Returns { hunks, oversize, identical } so the caller can decide UX.
 */
function computeInlineDiff(oldText, newText, opts = {}) {
  const contextLines =
    typeof opts.contextLines === 'number' ? opts.contextLines : CONTEXT_LINES;
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) {
    return { hunks: [], oversize: false, identical: true };
  }
  if (oldText === newText) {
    return { hunks: [], oversize: false, identical: true };
  }
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return { hunks: [], oversize: true, identical: false };
  }

  const edits = diffLines(oldLines, newLines);
  const hunks = editsToHunks(edits, contextLines);
  return { hunks, oversize: false, identical: hunks.length === 0 };
}

/**
 * Render hunks as standard unified-diff text (no header — caller
 * supplies the file-name header). Used by PR-composer + ai-handoff.
 */
function renderUnifiedDiff(diffResult, opts = {}) {
  if (!diffResult || !Array.isArray(diffResult.hunks) || diffResult.hunks.length === 0) {
    return diffResult && diffResult.oversize
      ? '(file too large for inline diff)'
      : '';
  }
  const filenameOld = opts.oldName || 'a/file';
  const filenameNew = opts.newName || 'b/file';
  const lines = [];
  lines.push(`--- ${filenameOld}`);
  lines.push(`+++ ${filenameNew}`);
  for (const h of diffResult.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
      lines.push(prefix + l.text);
    }
  }
  return lines.join('\n');
}

/**
 * One-line summary for the FixSelectionPanel preview / PR body.
 */
function summariseDiff(diffResult) {
  if (!diffResult) return '';
  if (diffResult.oversize) return '(file too large for inline diff)';
  if (diffResult.identical) return '(no changes)';
  let added = 0;
  let removed = 0;
  for (const h of diffResult.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') added++;
      else if (l.type === 'remove') removed++;
    }
  }
  return `${added} line${added === 1 ? '' : 's'} added, ${removed} line${removed === 1 ? '' : 's'} removed across ${diffResult.hunks.length} hunk${diffResult.hunks.length === 1 ? '' : 's'}`;
}

module.exports = {
  MAX_LINES,
  CONTEXT_LINES,
  splitLines,
  diffLines,
  editsToHunks,
  computeInlineDiff,
  renderUnifiedDiff,
  summariseDiff,
};
