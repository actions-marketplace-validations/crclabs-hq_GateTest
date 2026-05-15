'use strict';

/**
 * Per-tier fix-cap enforcement.
 *
 * Companion to finding-clusterer.js. The clusterer collapses 1000 raw
 * findings into ~30 file-clusters and ranks them by impact. This module
 * decides HOW MANY of those clusters the customer's tier actually pays
 * for. Anything beyond the cap ships in the PR as advisory (rule key +
 * file + count), not as a Claude fix.
 *
 * Why caps matter: a single fix loop iteration is roughly $0.05-0.20 in
 * Anthropic spend (depends on file size + retries). At 1000 clusters
 * uncapped, a single $99 scan would cost us $50-200 in API calls before
 * we ship anything else. Caps make the unit economics work.
 *
 * The numbers below are the spend-vs-revenue ceiling — calibrate them
 * over time against real-world traffic, but never let a single scan
 * exceed the customer's paid price in API costs.
 *
 *   Quick     $29  →  5 file-fixes max
 *   Full      $99  → 20 file-fixes max
 *   Scan+Fix $199 → 50 file-fixes max
 *   Nuclear  $399 → 100 file-fixes max
 *
 * Pure JS. No I/O.
 */

const TIER_CAPS = Object.freeze({
  quick: 5,
  full: 20,
  scan_fix: 50,
  scanFix: 50, // both spellings — different callers normalize differently
  nuclear: 100,
});

// Fallback for callers that pass an unknown / missing tier. Chosen
// conservatively — better to under-deliver and refund than blow the budget.
const DEFAULT_CAP = TIER_CAPS.full;

/**
 * @param {string|undefined} tier
 * @returns {number}
 */
function getCapForTier(tier) {
  if (typeof tier !== 'string') return DEFAULT_CAP;
  const normalized = tier.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TIER_CAPS, normalized)) {
    return TIER_CAPS[normalized];
  }
  return DEFAULT_CAP;
}

/**
 * Split a ranked cluster list into a "to-fix" set (within the cap) and
 * an "advisory" set (above the cap — surfaced in the PR comment with
 * file + count, no Claude fix).
 *
 * @param {Array<{file:string, count:number, topSeverity:string, isRootCause:boolean, modules:string[]}>} clusters
 *        - assumed already ranked by `rankClusters` (highest impact first)
 * @param {string} tier - 'quick' | 'full' | 'scan_fix' | 'nuclear'
 * @returns {{
 *   toFix: Array,
 *   advisory: Array,
 *   cap: number,
 *   tier: string,
 *   wouldHaveFixed: number,    // number of clusters skipped due to the cap
 *   advisoryIssueCount: number, // sum of issue counts in advisory clusters
 * }}
 */
function applyFixCap(clusters, tier) {
  const cap = getCapForTier(tier);
  const list = Array.isArray(clusters) ? clusters : [];
  const toFix = list.slice(0, cap);
  const advisory = list.slice(cap);
  const advisoryIssueCount = advisory.reduce((acc, c) => acc + (c.count || 0), 0);
  return {
    toFix,
    advisory,
    cap,
    tier: typeof tier === 'string' ? tier : 'full',
    wouldHaveFixed: advisory.length,
    advisoryIssueCount,
  };
}

/**
 * Flatten a list of clusters back into the IssueInput[] shape the
 * existing fix route expects.
 *
 * @param {Array<{issues: Array}>} clusters
 * @returns {Array}
 */
function clustersToIssues(clusters) {
  const out = [];
  for (const cluster of clusters || []) {
    if (!cluster || !Array.isArray(cluster.issues)) continue;
    for (const issue of cluster.issues) out.push(issue);
  }
  return out;
}

/**
 * Render the advisory list as a compact markdown block suitable for a
 * PR comment footer. Keep it terse — customers care about WHAT was left
 * out, not paragraphs of justification.
 *
 * @param {{advisory: Array, cap: number, tier: string, advisoryIssueCount: number}} capResult
 * @returns {string}
 */
function renderAdvisorySection(capResult) {
  if (!capResult || !Array.isArray(capResult.advisory) || capResult.advisory.length === 0) {
    return '';
  }
  const lines = [];
  lines.push(`## Advisory — ${capResult.advisory.length} more files (${capResult.advisoryIssueCount} findings)`);
  lines.push('');
  lines.push(`Your **${capResult.tier}** tier covers ${capResult.cap} file-fixes per scan. The list below ranks the next files by impact — upgrade to a higher tier to have these fixed too, or fix them yourself with the per-file rule keys below.`);
  lines.push('');
  lines.push('| File | Severity | Findings | Modules |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of capResult.advisory.slice(0, 50)) {
    const file = '`' + c.file + '`';
    const sev = c.topSeverity || 'warning';
    const count = c.count || 0;
    const modules = Array.isArray(c.modules) && c.modules.length > 0 ? c.modules.join(', ') : '—';
    lines.push(`| ${file} | ${sev} | ${count} | ${modules} |`);
  }
  if (capResult.advisory.length > 50) {
    lines.push('');
    lines.push(`_+ ${capResult.advisory.length - 50} more files not shown._`);
  }
  return lines.join('\n');
}

module.exports = {
  TIER_CAPS,
  DEFAULT_CAP,
  getCapForTier,
  applyFixCap,
  clustersToIssues,
  renderAdvisorySection,
};
