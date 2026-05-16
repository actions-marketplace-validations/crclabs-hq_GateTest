'use strict';

/**
 * Scan-result diffing engine for trend tracking + drift alerts.
 *
 * Compares two scan results (a baseline + a current) and returns a
 * structured diff: what's newly broken, what got fixed, what's
 * persistent, and how the Health Score moved. Pure logic — the alert
 * email generator + the customer's dashboard both read from this.
 *
 * The diff is finding-cluster-aware: a new "missing CSP" cluster
 * with 200 instances is ONE new finding event in the alert email,
 * not 200. Same shape the URL-scan engine uses.
 *
 * Pure JS. Deterministic. No I/O.
 */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

function clusterKey(cluster) {
  if (!cluster) return null;
  if (typeof cluster.ruleKey === 'string' && cluster.ruleKey) return cluster.ruleKey;
  if (typeof cluster.title === 'string' && cluster.module) return `${cluster.module}:${cluster.title}`;
  return cluster.title || cluster.module || null;
}

/**
 * Compute a diff between two scan results.
 *
 * @param {Object} baseline       full scan result from a previous run
 * @param {Object} current        full scan result from the latest run
 * @returns {{
 *   scoreChange: { from: number, to: number, delta: number, gradeFrom: string, gradeTo: string, direction: 'up'|'down'|'flat' },
 *   newFindings: Array<Cluster>,
 *   resolvedFindings: Array<Cluster>,
 *   persistentFindings: Array<{ baseline: Cluster, current: Cluster, countDelta: number }>,
 *   countShift: { errorDelta: number, warningDelta: number, totalClusterDelta: number },
 *   regression: boolean,
 *   improvement: boolean,
 * }}
 */
function diffScans(baseline, current) {
  const b = baseline || {};
  const c = current || {};
  const bClusters = Array.isArray(b.findings) ? b.findings : [];
  const cClusters = Array.isArray(c.findings) ? c.findings : [];

  const bByKey = new Map();
  for (const cl of bClusters) {
    const k = clusterKey(cl);
    if (k) bByKey.set(k, cl);
  }
  const cByKey = new Map();
  for (const cl of cClusters) {
    const k = clusterKey(cl);
    if (k) cByKey.set(k, cl);
  }

  const newFindings = [];
  const persistentFindings = [];
  for (const [k, cl] of cByKey) {
    if (bByKey.has(k)) {
      const bCl = bByKey.get(k);
      const countDelta = (cl.instanceCount || 1) - (bCl.instanceCount || 1);
      persistentFindings.push({ baseline: bCl, current: cl, countDelta });
    } else {
      newFindings.push(cl);
    }
  }
  const resolvedFindings = [];
  for (const [k, cl] of bByKey) {
    if (!cByKey.has(k)) resolvedFindings.push(cl);
  }

  // Sort each list by severity then by instance count desc.
  const sortBySev = (a, b) => {
    const sa = SEVERITY_RANK[a.severity ?? 'warning'] ?? 1;
    const sb = SEVERITY_RANK[b.severity ?? 'warning'] ?? 1;
    if (sa !== sb) return sa - sb;
    return (b.instanceCount ?? 1) - (a.instanceCount ?? 1);
  };
  newFindings.sort(sortBySev);
  resolvedFindings.sort(sortBySev);
  persistentFindings.sort((x, y) => sortBySev(x.current, y.current));

  const bScore = (b.healthScore && typeof b.healthScore.score === 'number') ? b.healthScore.score : null;
  const cScore = (c.healthScore && typeof c.healthScore.score === 'number') ? c.healthScore.score : null;
  const bGrade = (b.healthScore && b.healthScore.grade) || null;
  const cGrade = (c.healthScore && c.healthScore.grade) || null;
  const delta = (cScore != null && bScore != null) ? cScore - bScore : 0;
  const direction = delta > 1 ? 'up' : delta < -1 ? 'down' : 'flat';

  const bErr = bClusters.filter((cl) => cl.severity === 'error').length;
  const cErr = cClusters.filter((cl) => cl.severity === 'error').length;
  const bWarn = bClusters.filter((cl) => cl.severity === 'warning').length;
  const cWarn = cClusters.filter((cl) => cl.severity === 'warning').length;

  const regression = delta < -3 || cErr > bErr || newFindings.some((f) => f.severity === 'error' || f.highSignal);
  // Improvement = score climbed materially AND nothing new appeared. Either
  // a finding got resolved, or the underlying instance counts dropped.
  const improvement =
    delta > 3 &&
    newFindings.length === 0 &&
    cErr <= bErr &&
    (resolvedFindings.length > 0 || (cWarn < bWarn));

  return {
    scoreChange: {
      from: bScore, to: cScore, delta, gradeFrom: bGrade, gradeTo: cGrade, direction,
    },
    newFindings,
    resolvedFindings,
    persistentFindings,
    countShift: {
      errorDelta: cErr - bErr,
      warningDelta: cWarn - bWarn,
      totalClusterDelta: cClusters.length - bClusters.length,
    },
    regression,
    improvement,
  };
}

/**
 * Should we send an alert email for this diff? Suppress noise — we only
 * email when something materially changed. Customer can override via
 * subscription.alertOn = 'always' if they prefer weekly digest.
 *
 * @param {ReturnType<diffScans>} diff
 * @returns {{ shouldAlert: boolean, reasons: string[] }}
 */
function shouldAlert(diff) {
  const reasons = [];
  if (diff.regression) reasons.push('regression detected');
  if (diff.newFindings.length > 0) reasons.push(`${diff.newFindings.length} new finding(s)`);
  if ((diff.scoreChange.delta || 0) <= -5) reasons.push(`health score dropped ${Math.abs(diff.scoreChange.delta)} points`);
  if (diff.improvement) reasons.push('improvement — share the win');
  return { shouldAlert: reasons.length > 0, reasons };
}

module.exports = {
  diffScans,
  shouldAlert,
  clusterKey,
};
