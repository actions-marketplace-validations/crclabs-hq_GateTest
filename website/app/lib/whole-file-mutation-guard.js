/**
 * Whole-file mutation guard.
 *
 * Phase-1 fallback safety net for the auto-fix path. The surgical
 * (line-targeted) fixer handles most issues; this guard sits in front of
 * the WHOLE-FILE rewrite fallback that runs when an issue can't be
 * surgically processed (no parseable line number, `CREATE_FILE:` shapes,
 * or anything else that forces Claude to regenerate the entire file).
 *
 * The failure mode this catches:
 *   Claude is asked to "fix issue X in file Y" and returns a file with
 *   the bug fixed AND a hundred unrelated reformatting / "improvement"
 *   edits that vandalise the customer's code. Surgical mode prevents
 *   this by construction; whole-file mode does not. Without this guard,
 *   a 3-line bug fix can ship as a 200-line drift PR.
 *
 * Strategy:
 *   1. Diff the original and fixed files line-by-line (naive forward-scan,
 *      no diff library — Node stdlib only).
 *   2. Reject if the change exceeds the budget allowed by the issue
 *      count, an absolute floor, or a percentage of the file.
 *   3. Return a structured result the API route can log and the PR body
 *      can summarise.
 *
 * Pure JS, zero new dependencies. Same module style as
 * `cross-fix-syntax-gate.js`.
 */

'use strict';

/**
 * Compute a naive line-level diff between original and fixed file
 * contents. Walks both arrays forward; on a mismatch, scans ahead in
 * `fixed` for the next matching line within a 50-line window. Lines in
 * the window before the match count as added; the original line(s)
 * skipped count as removed. If no match is found inside the window,
 * the line is treated as a 1-for-1 replacement (1 add + 1 remove).
 *
 * Convention: a "replaced" line counts as 1 added + 1 removed. The
 * `totalChangedLines` field is `addedLines + removedLines`, so a single
 * line replacement contributes 2 to the total. This keeps the math
 * simple and is the right shape for the budget check (a whole-file
 * reformat will produce a totalChangedLines roughly = 2 * file size,
 * which trips every threshold).
 *
 * @param {string} original
 * @param {string} fixed
 * @returns {{
 *   changedLines: number,
 *   addedLines: number,
 *   removedLines: number,
 *   totalChangedLines: number,
 * }}
 */
function computeLineDiff(original, fixed) {
  const origStr = typeof original === 'string' ? original : '';
  const fixStr = typeof fixed === 'string' ? fixed : '';

  if (origStr === fixStr) {
    return { changedLines: 0, addedLines: 0, removedLines: 0, totalChangedLines: 0 };
  }

  const origLines = origStr.split('\n');
  const fixLines = fixStr.split('\n');
  // Look-ahead window for the re-sync scan. 200 is generous enough to
  // catch a 100-line insertion (the reasonable upper bound of a
  // legitimate whole-file fix) while still being O(N*W) cheap. When
  // the window is exhausted on both sides, the algorithm correctly
  // collapses to a 1-for-1 replacement count, which is the safe
  // overcount: it pushes the diff toward rejection rather than away.
  const WINDOW = 200;

  let i = 0; // pointer into origLines
  let j = 0; // pointer into fixLines
  let added = 0;
  let removed = 0;
  let changed = 0;

  while (i < origLines.length && j < fixLines.length) {
    if (origLines[i] === fixLines[j]) {
      i++;
      j++;
      continue;
    }

    // Mismatch — scan ahead in `fixed` for the next match of origLines[i]
    // within the window. If found, everything between j and that index
    // is "added".
    let aheadInFix = -1;
    const fixLimit = Math.min(fixLines.length, j + WINDOW);
    for (let k = j + 1; k < fixLimit; k++) {
      if (fixLines[k] === origLines[i]) {
        aheadInFix = k;
        break;
      }
    }

    // Also scan ahead in `original` for the next match of fixLines[j]
    // within the window. If found, everything between i and that index
    // is "removed".
    let aheadInOrig = -1;
    const origLimit = Math.min(origLines.length, i + WINDOW);
    for (let k = i + 1; k < origLimit; k++) {
      if (origLines[k] === fixLines[j]) {
        aheadInOrig = k;
        break;
      }
    }

    if (aheadInFix !== -1 && aheadInOrig === -1) {
      // Pure insertion in fixed.
      added += aheadInFix - j;
      j = aheadInFix;
    } else if (aheadInOrig !== -1 && aheadInFix === -1) {
      // Pure deletion from original.
      removed += aheadInOrig - i;
      i = aheadInOrig;
    } else if (aheadInFix !== -1 && aheadInOrig !== -1) {
      // Both directions found a re-sync. Prefer the closer one — that's
      // the simpler edit. Tie-break: prefer insertion (more common in
      // bug fixes that add a guard or import line).
      const fixGap = aheadInFix - j;
      const origGap = aheadInOrig - i;
      if (fixGap <= origGap) {
        added += fixGap;
        j = aheadInFix;
      } else {
        removed += origGap;
        i = aheadInOrig;
      }
    } else {
      // No match in either direction within the window — treat as a
      // 1-for-1 replacement.
      changed += 1;
      i++;
      j++;
    }
  }

  // Tail: anything left in either array.
  if (i < origLines.length) {
    removed += origLines.length - i;
  }
  if (j < fixLines.length) {
    added += fixLines.length - j;
  }

  const totalChangedLines = added + removed + changed * 2;

  return {
    changedLines: changed,
    addedLines: added,
    removedLines: removed,
    totalChangedLines,
  };
}

/**
 * Evaluate whether a whole-file mutation is within the allowed budget.
 *
 * Three thresholds:
 *   - per-issue: totalChangedLines must not exceed issueCount * maxChangePerIssue.
 *   - absolute: AND totalChangedLines must exceed maxAbsoluteChange to reject on the per-issue rule.
 *     (This means a small file gets a free pass on the per-issue rule;
 *     a 5-line change in a 30-line file is fine even if there's only
 *     1 issue.)
 *   - percent: totalChangedLines / max(originalLines, 1) must not exceed maxPercentChange.
 *
 * @param {{
 *   original: string,
 *   fixed: string,
 *   issueCount: number,
 *   maxChangePerIssue?: number,
 *   maxAbsoluteChange?: number,
 *   maxPercentChange?: number,
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   stats: {
 *     issueCount: number,
 *     originalLines: number,
 *     fixedLines: number,
 *     addedLines: number,
 *     removedLines: number,
 *     changedLines: number,
 *     totalChangedLines: number,
 *     percentChange: number,
 *     perIssueBudget: number,
 *     absoluteBudget: number,
 *     percentBudget: number,
 *   },
 * }}
 */
function evaluateMutation(opts) {
  const {
    original = '',
    fixed = '',
    issueCount = 0,
    maxChangePerIssue = 8,
    maxAbsoluteChange = 80,
    maxPercentChange = 0.30,
  } = opts || {};

  const safeIssueCount = Math.max(0, Number(issueCount) || 0);
  const diff = computeLineDiff(original, fixed);
  const originalLines = (typeof original === 'string' ? original : '').split('\n').length;
  const fixedLines = (typeof fixed === 'string' ? fixed : '').split('\n').length;
  const denom = Math.max(originalLines, 1);
  const percentChange = diff.totalChangedLines / denom;

  const perIssueBudget = safeIssueCount * maxChangePerIssue;

  const stats = {
    issueCount: safeIssueCount,
    originalLines,
    fixedLines,
    addedLines: diff.addedLines,
    removedLines: diff.removedLines,
    changedLines: diff.changedLines,
    totalChangedLines: diff.totalChangedLines,
    percentChange,
    perIssueBudget,
    absoluteBudget: maxAbsoluteChange,
    percentBudget: maxPercentChange,
  };

  // Rule 1: percent of file. Checked first because it catches the
  // worst whole-file-rewrite cases and we want the reason string to
  // explain the percentage when both rules would trip — that's the
  // most useful signal to the customer.
  if (percentChange > maxPercentChange) {
    const pct = (percentChange * 100).toFixed(1);
    const budgetPct = (maxPercentChange * 100).toFixed(0);
    return {
      ok: false,
      reason: `change of ${diff.totalChangedLines} lines is ${pct}% of file (max ${budgetPct}%)`,
      stats,
    };
  }

  // Rule 2: per-issue × maxChangePerIssue, AND'd with the absolute
  // floor so small files don't trip on it.
  if (
    diff.totalChangedLines > perIssueBudget &&
    diff.totalChangedLines > maxAbsoluteChange
  ) {
    return {
      ok: false,
      reason: `change of ${diff.totalChangedLines} lines exceeds budget for ${safeIssueCount} issue${safeIssueCount === 1 ? '' : 's'} (allowed: ${perIssueBudget}, absolute floor: ${maxAbsoluteChange})`,
      stats,
    };
  }

  return { ok: true, stats };
}

/**
 * One-line human-readable summary suitable for a log line or a PR-body
 * footnote. Stable shape so callers can rely on it.
 *
 * @param {{ ok: boolean, reason?: string, stats: object }} result
 * @returns {string}
 */
function summariseMutation(result) {
  if (!result || !result.stats) return 'mutation guard: not run';
  const s = result.stats;
  const pct = (s.percentChange * 100).toFixed(1);
  if (result.ok) {
    return `mutation guard: accepted (${s.totalChangedLines} lines changed, ${pct}% of ${s.originalLines}-line file, ${s.issueCount} issue${s.issueCount === 1 ? '' : 's'})`;
  }
  const reason = result.reason || 'rejected';
  return `mutation guard: REJECTED — ${reason} (${s.addedLines} added / ${s.removedLines} removed / ${s.changedLines} replaced)`;
}

module.exports = {
  computeLineDiff,
  evaluateMutation,
  summariseMutation,
};
