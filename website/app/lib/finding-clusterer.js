'use strict';

/**
 * Finding clusterer + ranker.
 *
 * The unit-economics problem: a real scan returns 900-1000 findings across
 * 90 modules. Naively fixing each one via Claude API costs $0.05+ per call,
 * which destroys the margin on a $99 scan AND often blows the customer's
 * patience long before it hits their wallet.
 *
 * The honest truth: those 1000 findings almost always collapse to ~30
 * unique fixes. A single `strict: false` in tsconfig.json produces 200
 * implicit-any warnings; a missing CSP header produces one finding per
 * route handler; a `parseFloat` on a money-named var produces a finding
 * per call site.
 *
 * This module does the collapsing. It groups findings by file (since the
 * existing fix loop already passes the whole file to Claude in one call,
 * a per-file group IS a cluster), filters by severity, and ranks the
 * clusters so we fix root-cause files first.
 *
 * Pure JS. No I/O. Deterministic. Easy to test.
 */

// Files that, when fixed, typically eliminate dozens of downstream findings.
// Order roughly by impact: tsconfig wins because one flag flip kills hundreds.
const ROOT_CAUSE_PATTERNS = [
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i,
  /(?:^|\/)\.eslintrc(?:\.[a-z]+)?$/i,
  /(?:^|\/)eslint\.config\.[mc]?[jt]s$/i,
  /(?:^|\/)next\.config\.[mc]?[jt]s$/i,
  /(?:^|\/)tailwind\.config\.[mc]?[jt]s$/i,
  /(?:^|\/)package\.json$/i,
  /(?:^|\/)\.env(?:\.[a-z]+)?(?:\.example)?$/i,
  /(?:^|\/)nginx\.conf$/i,
  /(?:^|\/)netlify\.toml$/i,
  /(?:^|\/)vercel\.json$/i,
  /(?:^|\/)docker-compose(?:\.[a-z]+)?\.ya?ml$/i,
  /(?:^|\/)Dockerfile(?:\.[a-z]+)?$/i,
  /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i,
  /(?:^|\/)prettier\.config\.[mc]?[jt]s$/i,
  /(?:^|\/)\.prettierrc(?:\.[a-z]+)?$/i,
];

const ERROR_HINTS = /\b(error|fail|vulnerab|exploit|injection|unsafe|critical|leak|exposed|disabled|bypass|impossible|catastrophic|unbounded|never|race|toctou|secret|credential|password|api[_\- ]?key|token|hardcoded)\b/i;
const WARNING_HINTS = /\b(warning|warn|should|consider|prefer|outdated|stale|deprecat|missing|unused|aging)\b/i;
const INFO_HINTS = /\b(summary|ok|note|scanned|info|library-ok)\b/i;

/**
 * Heuristic severity classification. Mirrors `selectable-findings.js`
 * so the UI grouping and the fix-time clustering agree.
 *
 * @param {string} raw - the issue text
 * @returns {'error'|'warning'|'info'}
 */
function classifySeverity(raw) {
  if (typeof raw !== 'string') return 'warning';
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return 'error';
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return 'warning';
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return 'info';
  const lower = raw.toLowerCase();
  if (ERROR_HINTS.test(lower)) return 'error';
  if (WARNING_HINTS.test(lower)) return 'warning';
  if (INFO_HINTS.test(lower)) return 'info';
  return 'warning';
}

/** @param {string} path */
function isRootCauseFile(path) {
  if (typeof path !== 'string') return false;
  return ROOT_CAUSE_PATTERNS.some((re) => re.test(path));
}

/**
 * Split a flat list of issues into three buckets by severity.
 *
 * Errors are always candidates for fixing. Warnings and info default to
 * advisory (rendered in the PR but not fixed), but a caller can opt to
 * include warnings if their tier budget allows.
 *
 * @param {Array<{file:string, issue:string, module:string, line?:number}>} issues
 * @returns {{errors: Array, warnings: Array, info: Array}}
 */
function partitionBySeverity(issues) {
  const errors = [];
  const warnings = [];
  const info = [];
  for (const issue of issues || []) {
    if (!issue || typeof issue !== 'object') continue;
    const sev = classifySeverity(issue.issue);
    if (sev === 'error') errors.push(issue);
    else if (sev === 'warning') warnings.push(issue);
    else info.push(issue);
  }
  return { errors, warnings, info };
}

/**
 * Group issues into per-file clusters. The fix loop downstream already
 * passes a whole file to Claude in a single call with all its issues,
 * so a per-file group is the natural unit of cost.
 *
 * @param {Array<{file:string, issue:string, module:string, line?:number}>} issues
 * @returns {Array<{
 *   file: string,
 *   issues: Array,
 *   count: number,
 *   modules: string[],
 *   severityCounts: {error: number, warning: number, info: number},
 *   topSeverity: 'error'|'warning'|'info',
 *   isRootCause: boolean,
 * }>}
 */
function clusterByFile(issues) {
  const map = new Map();
  for (const issue of issues || []) {
    if (!issue || typeof issue.file !== 'string' || !issue.file) continue;
    let cluster = map.get(issue.file);
    if (!cluster) {
      cluster = {
        file: issue.file,
        issues: [],
        modules: new Set(),
        severityCounts: { error: 0, warning: 0, info: 0 },
      };
      map.set(issue.file, cluster);
    }
    cluster.issues.push(issue);
    if (issue.module) cluster.modules.add(issue.module);
    const sev = classifySeverity(issue.issue);
    cluster.severityCounts[sev] += 1;
  }

  const SEV_RANK = { error: 0, warning: 1, info: 2 };
  return Array.from(map.values()).map((c) => {
    let top = 'info';
    if (c.severityCounts.error > 0) top = 'error';
    else if (c.severityCounts.warning > 0) top = 'warning';
    return {
      file: c.file,
      issues: c.issues,
      count: c.issues.length,
      modules: Array.from(c.modules).sort(),
      severityCounts: c.severityCounts,
      topSeverity: top,
      isRootCause: isRootCauseFile(c.file),
      _sevRank: SEV_RANK[top],
    };
  });
}

/**
 * Sort clusters so the highest-impact files come first.
 *
 * Priority order:
 *   1. Root-cause files (one fix kills many downstream findings)
 *   2. Top severity (error > warning > info)
 *   3. Issue count descending (more issues in one file = bigger win)
 *   4. File path alphabetical (deterministic tie-break for tests)
 *
 * @param {Array} clusters - output of clusterByFile
 * @returns {Array} same clusters, sorted (mutates input array AND returns it)
 */
function rankClusters(clusters) {
  if (!Array.isArray(clusters)) return [];
  clusters.sort((a, b) => {
    if (a.isRootCause !== b.isRootCause) return a.isRootCause ? -1 : 1;
    if (a._sevRank !== b._sevRank) return a._sevRank - b._sevRank;
    if (a.count !== b.count) return b.count - a.count;
    return a.file.localeCompare(b.file);
  });
  return clusters;
}

/**
 * One-shot helper: filter to error-severity, cluster by file, rank.
 *
 * The default policy: fix errors only. Warnings + info go in the
 * advisory bucket and ship in the PR comment, not the diff.
 *
 * @param {Array} issues
 * @param {{includeWarnings?: boolean}} [opts]
 * @returns {{
 *   clusters: Array,
 *   advisory: {warnings: Array, info: Array},
 *   totalIssuesIn: number,
 *   totalIssuesClustered: number,
 * }}
 */
function clusterAndRank(issues, opts = {}) {
  const totalIssuesIn = Array.isArray(issues) ? issues.length : 0;
  const partitioned = partitionBySeverity(issues);
  const fixable = opts.includeWarnings
    ? [...partitioned.errors, ...partitioned.warnings]
    : partitioned.errors;
  const clusters = rankClusters(clusterByFile(fixable));
  const totalIssuesClustered = clusters.reduce((acc, c) => acc + c.count, 0);
  return {
    clusters,
    advisory: {
      warnings: opts.includeWarnings ? [] : partitioned.warnings,
      info: partitioned.info,
    },
    totalIssuesIn,
    totalIssuesClustered,
  };
}

module.exports = {
  classifySeverity,
  isRootCauseFile,
  partitionBySeverity,
  clusterByFile,
  rankClusters,
  clusterAndRank,
  ROOT_CAUSE_PATTERNS,
};
