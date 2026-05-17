'use strict';

/**
 * URL-scan finding clusterer.
 *
 * Companion to `finding-clusterer.js` (which is repo-fix-flow focused). The
 * repo flow groups by file because the unit of work is a Claude fix-call
 * per file. URL scans have no fix call — they only report. The natural
 * cluster unit is the rule (e.g. "missing CSP header" reported once, not
 * once per page; "TLS chain incomplete" once, not per request).
 *
 * Input: the WpFinding[] shape that `translateFinding()` in
 *   wp/scan/route.ts already emits: { severity, title, body, module, ruleKey }
 * Output: clusters of { ruleKey, severity, title, body, module, count,
 *   instances, isHighSignal }
 *
 * "High signal" is the URL-scan analogue of "root cause" from the repo
 * flow — rules that immediately tell the customer the site is dangerously
 * broken (TLS missing, XML-RPC open, exposed secrets, admin endpoints
 * reachable, subdomain takeover). They sort to the top.
 *
 * Pure JS. No I/O. Deterministic.
 */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

// Rule-key prefixes that are "the site is dangerously broken" signals.
// These rank above generic warnings of the same severity because the
// customer's most-likely action is "fix this NOW", not "schedule a
// hardening sprint."
const HIGH_SIGNAL_PREFIXES = [
  'wp-exposed-files',           // sensitive files reachable
  'wp-xmlrpc:pingback',         // DDoS amplification
  'tls-security:',              // missing/invalid HTTPS
  'tls-',                       // legacy spelling
  'admin-discovery:',           // admin/dashboard reachable
  'subdomain-takeover:',        // dangling DNS
  'open-redirect:',             // open redirect param
  'secret-leak:',               // credential / token in HTML or JS
  'mixed-content:error',        // active mixed content
  'csp:missing',                // no CSP at all
  'csp:unsafe-eval',            // CSP allows eval
  'crawl:broken-scripts',       // JS bundle 404 = features silently break
  'crawl:broken-stylesheets',   // CSS 404 = users see unstyled HTML
  'crawl:error:js-runtime-error',
  'crawl:error:hydration-error',
  'crawl:error:server-error',
  'crawl:error:app-error',
  'runtime-errors:page-error',  // uncaught JS during page load
  'runtime-errors:csp-violation',
  'runtime-errors:navigation',  // page didn't load at all
];

/** @param {string} ruleKey */
function isHighSignal(ruleKey) {
  if (typeof ruleKey !== 'string') return false;
  const k = ruleKey.toLowerCase();
  return HIGH_SIGNAL_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Normalise a single finding into the cluster key. We dedupe by the
 * full ruleKey by default; if a caller wants finer-grained clustering
 * (e.g. one cluster per affected URL), pass `byInstance: true`.
 *
 * @param {{ruleKey?: string, module?: string, title?: string}} finding
 * @returns {string}
 */
function clusterKeyFor(finding) {
  if (!finding) return 'unknown';
  if (typeof finding.ruleKey === 'string' && finding.ruleKey) return finding.ruleKey;
  if (typeof finding.title === 'string' && finding.title) {
    return `${finding.module || 'unknown'}:${finding.title.slice(0, 80)}`;
  }
  return finding.module || 'unknown';
}

/**
 * @param {Array<{severity:string,title:string,body:string,module:string,ruleKey:string,url?:string}>} findings
 * @returns {Array<{
 *   ruleKey: string,
 *   severity: 'error'|'warning'|'info',
 *   title: string,
 *   body: string,
 *   module: string,
 *   count: number,
 *   instances: Array,
 *   isHighSignal: boolean,
 * }>}
 */
function clusterByRule(findings) {
  if (!Array.isArray(findings)) return [];
  const map = new Map();
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const key = clusterKeyFor(f);
    let cluster = map.get(key);
    if (!cluster) {
      cluster = {
        ruleKey: f.ruleKey || key,
        severity: f.severity || 'warning',
        title: f.title || '',
        body: f.body || '',
        module: f.module || 'general',
        count: 0,
        instances: [],
        isHighSignal: isHighSignal(key),
      };
      map.set(key, cluster);
    }
    cluster.count += 1;
    cluster.instances.push(f);
    // If this instance has a more severe rating than the cluster's
    // first-seen severity, promote the cluster. Errors win over warnings.
    if (
      SEVERITY_RANK[f.severity] !== undefined &&
      SEVERITY_RANK[f.severity] < SEVERITY_RANK[cluster.severity]
    ) {
      cluster.severity = f.severity;
    }
  }
  return Array.from(map.values());
}

/**
 * Sort clusters so the highest-impact ones surface first.
 *
 * Priority:
 *   1. High-signal rule (site is dangerously broken — TLS missing, XML-RPC
 *      open, admin reachable, subdomain takeover, open redirect, etc.)
 *   2. Severity (error > warning > info)
 *   3. Instance count descending (one finding = isolated; many = pattern)
 *   4. Rule key alphabetical (deterministic tie-break for tests)
 */
function rankClusters(clusters) {
  if (!Array.isArray(clusters)) return [];
  clusters.sort((a, b) => {
    if (a.isHighSignal !== b.isHighSignal) return a.isHighSignal ? -1 : 1;
    const sa = SEVERITY_RANK[a.severity] ?? 1;
    const sb = SEVERITY_RANK[b.severity] ?? 1;
    if (sa !== sb) return sa - sb;
    if (a.count !== b.count) return b.count - a.count;
    return a.ruleKey.localeCompare(b.ruleKey);
  });
  return clusters;
}

/**
 * Filter + cluster + rank one-shot. Drops info-severity by default
 * (caller can opt in with `includeInfo: true`).
 *
 * @param {Array} findings
 * @param {{includeInfo?: boolean}} [opts]
 */
function clusterAndRankUrlFindings(findings, opts = {}) {
  const totalIn = Array.isArray(findings) ? findings.length : 0;
  const fixable = (findings || []).filter((f) => {
    if (!f) return false;
    if (opts.includeInfo) return true;
    return f.severity !== 'info';
  });
  const droppedInfo = totalIn - fixable.length;
  const clusters = rankClusters(clusterByRule(fixable));
  const totalInstances = clusters.reduce((acc, c) => acc + c.count, 0);
  return {
    clusters,
    totalIn,
    totalInstances,
    droppedInfo,
  };
}

module.exports = {
  SEVERITY_RANK,
  HIGH_SIGNAL_PREFIXES,
  isHighSignal,
  clusterKeyFor,
  clusterByRule,
  rankClusters,
  clusterAndRankUrlFindings,
};
