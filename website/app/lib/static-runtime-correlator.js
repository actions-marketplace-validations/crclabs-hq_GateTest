/**
 * Phase 6.2.3 — Static-finding ↔ runtime correlator.
 *
 * The killer feature: when GateTest finds an issue at src/api/checkout.ts:42,
 * we cross-reference Datadog logs and Vercel Analytics to ask — did this
 * exact location throw in production in the last 7 days? If yes, the finding
 * gets a 🔥 LIVE badge and jumps to the top of the priority list.
 *
 * The badge changes "nice to fix someday" into "fix this before standup."
 *
 * Algorithm:
 *   1. Receive static findings (from scan) + runtime events (from Datadog / Vercel)
 *   2. For each finding, attempt file:line cross-reference against runtime events
 *   3. If a runtime event's sourceLocation.file fuzzy-matches the finding's file
 *      AND the line is within ±10 of the finding's line → LIVE badge
 *   4. Re-sort findings: LIVE errors first, then non-LIVE errors, then warnings
 *
 * Pure function — no I/O. Tested standalone. Callers pass pre-fetched data.
 */

'use strict';

const LIVE_LINE_TOLERANCE = 10; // lines ± to fuzzy-match stack frames

/**
 * Fuzzy file path match: /home/app/src/api/checkout.ts and
 * src/api/checkout.ts should match. Strip leading path components
 * until both tails agree.
 */
function filePathsMatch(findingFile, runtimeFile) {
  if (!findingFile || !runtimeFile) return false;

  // Normalize separators
  const a = findingFile.replace(/\\/g, '/').replace(/^\.\//, '');
  const b = runtimeFile.replace(/\\/g, '/').replace(/^\.\//, '');

  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;

  // Compare last N path components
  const aParts = a.split('/');
  const bParts = b.split('/');
  const minLen = Math.min(aParts.length, bParts.length);
  for (let n = minLen; n >= 1; n--) {
    const aTail = aParts.slice(-n).join('/');
    const bTail = bParts.slice(-n).join('/');
    if (aTail === bTail) return true;
  }

  return false;
}

/**
 * Check if a runtime event matches a finding's file + line.
 *
 * @param {object} finding       { file, line, ... }
 * @param {object} runtimeEvent  { sourceLocation: { file, line } | null, ... }
 */
function isLiveMatch(finding, runtimeEvent) {
  const loc = runtimeEvent.sourceLocation;
  if (!loc || !loc.file) return false;
  if (!filePathsMatch(finding.file, loc.file)) return false;

  // Line match within tolerance
  const findingLine = Number(finding.line || 0);
  const runtimeLine = Number(loc.line || 0);
  if (findingLine === 0 || runtimeLine === 0) return false;

  return Math.abs(findingLine - runtimeLine) <= LIVE_LINE_TOLERANCE;
}

/**
 * Correlate static findings with runtime events.
 *
 * @param {object} opts
 * @param {Array}  opts.findings         Static findings from GateTest scan.
 *                                       Each: { file, line, severity, detail, ... }
 * @param {Array}  [opts.datadogErrors]  From fetchTopErrors / fetchErrorTraces
 * @param {Array}  [opts.vercelRoutes]   From fetchRoutePerformance
 */
function correlateFindingsWithRuntime(opts = {}) {
  const {
    findings = [],
    datadogErrors = [],
    vercelRoutes = [],
  } = opts;

  // Combine all runtime events with source locations
  const runtimeEvents = [
    ...datadogErrors.filter(e => e.sourceLocation),
    ...datadogErrors.filter(e => !e.sourceLocation).map(e => ({ ...e, sourceLocation: null })),
  ];

  // Build Vercel route performance map for route-level correlation
  const routePerf = {};
  for (const r of vercelRoutes) {
    routePerf[r.route] = r;
  }

  const correlated = findings.map(finding => {
    // 1. Try exact file:line match against Datadog events
    const matchingEvents = runtimeEvents.filter(e =>
      isLiveMatch({ ...finding, line: finding.line || 0 }, e)
    );

    // 2. Try route-level match for API findings (file path contains /api/)
    let routeMatch = null;
    if (finding.file && /\/api\//.test(finding.file)) {
      const routeKey = finding.file
        .replace(/^.*\/api/, '/api')
        .replace(/\/route\.[jt]sx?$/, '')
        .replace(/\.[jt]sx?$/, '');
      routeMatch = routePerf[routeKey] || routePerf[`${routeKey}/`] || null;
    }

    const isLive = matchingEvents.length > 0;
    const isSlowRoute = routeMatch && routeMatch.lcp != null && routeMatch.lcp > 2500; // >2.5s LCP = 🐢

    return {
      ...finding,
      live: isLive,
      liveEvents: matchingEvents.slice(0, 3).map(e => ({
        service: e.service,
        timestamp: e.timestamp,
        message: (e.message || '').slice(0, 150),
        sourceFile: e.sourceLocation?.file,
        sourceLine: e.sourceLocation?.line,
      })),
      routePerformance: routeMatch ? {
        route: routeMatch.route,
        lcpP95: routeMatch.lcp,
        slow: isSlowRoute,
      } : null,
      priority: isLive ? 0 : (finding.severity === 'error' ? 1 : 2),
    };
  });

  // Sort: LIVE first, then errors, then warnings
  correlated.sort((a, b) => a.priority - b.priority || a.file?.localeCompare(b.file || '') || 0);

  const liveCount = correlated.filter(f => f.live).length;

  return {
    findings: correlated,
    liveCount,
    summary: liveCount > 0
      ? `🔥 ${liveCount} finding${liveCount !== 1 ? 's' : ''} confirmed active in production (last 7 days)`
      : 'No active production errors matched to these findings',
  };
}

/**
 * Render a markdown section describing live findings for a PR comment.
 */
function renderLiveBadgeSection(result) {
  const liveFindings = result.findings.filter(f => f.live);
  if (liveFindings.length === 0) return '';

  const lines = ['## 🔥 Active in Production\n'];
  lines.push(`**${liveFindings.length} finding${liveFindings.length !== 1 ? 's' : ''}** from this scan match real errors throwing in production right now. Fix these first.\n`);

  for (const f of liveFindings.slice(0, 10)) {
    lines.push(`### \`${f.file}:${f.line || '?'}\``);
    lines.push(`**Finding:** ${(f.detail || f.issue || '').slice(0, 120)}`);
    if (f.liveEvents.length > 0) {
      const e = f.liveEvents[0];
      lines.push(`**Latest prod error:** ${(e.message || '').slice(0, 100)}`);
      if (e.timestamp) lines.push(`**When:** ${new Date(e.timestamp).toLocaleString()}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { correlateFindingsWithRuntime, renderLiveBadgeSection, filePathsMatch, isLiveMatch };
