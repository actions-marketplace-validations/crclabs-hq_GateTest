'use strict';

/**
 * Phase 5.3.4 / Phase 6.2.3 — Static↔runtime correlator.
 *
 * Pure function — no network calls. Callers fetch runtime data from Sentry,
 * Datadog, or Vercel and pass it in as normalised events.
 *
 * When a GateTest scan finds an issue at `src/api/checkout.ts:42`, this module
 * cross-references the runtime events: did this exact file:line throw in prod
 * last 7 days? If yes, the finding gets liveInProd=true and jumps to the top
 * of the priority list with a 🔥 LIVE badge.
 *
 * Matching is fuzzy: file paths are normalised (strip src/, app/ prefixes) and
 * line numbers allow ±FILE_MATCH_FUZZ slack to tolerate minor line drift.
 */

const FILE_MATCH_FUZZ = 3; // line number tolerance

// ─── Path normalisation ───────────────────────────────────────────────────────

/**
 * Strip common prefixes so `src/api/checkout.ts` matches `api/checkout.ts`
 * and `website/app/api/checkout.ts` matches `app/api/checkout.ts`.
 */
function normalisePath(p) {
  if (!p || typeof p !== 'string') return '';
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/?(?:website\/app|website\/src|src|app|pages)\//, '')
    .toLowerCase();
}

function pathsMatch(scanPath, runtimePath) {
  const a = normalisePath(scanPath);
  const b = normalisePath(runtimePath);
  if (!a || !b) return false;
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

function linesMatch(scanLine, runtimeLine) {
  if (typeof scanLine !== 'number' || typeof runtimeLine !== 'number') return false;
  return Math.abs(scanLine - runtimeLine) <= FILE_MATCH_FUZZ;
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * Check a single scan finding against runtime error events.
 *
 * @param {{ file: string, line: number | null }} finding
 * @param {Array<{ frames: Array<{ file: string, lineno: number }>, count?: number }>} runtimeEvents
 * @returns {Object | null} first matching event, or null
 */
function matchFinding(finding, runtimeEvents) {
  if (!finding || !Array.isArray(runtimeEvents)) return null;

  for (const event of runtimeEvents) {
    const frames = Array.isArray(event.frames) ? event.frames : [];
    for (const frame of frames) {
      if (!pathsMatch(finding.file, frame.file)) continue;

      // If finding has a line number, require fuzzy line match
      if (typeof finding.line === 'number' && finding.line > 0) {
        if (!linesMatch(finding.line, frame.lineno)) continue;
      }

      return event;
    }
  }

  return null;
}

// ─── Main correlator ──────────────────────────────────────────────────────────

/**
 * Correlate static scan findings against runtime events.
 *
 * @param {Array<{ file: string, line: number | null, severity: string, module: string, message: string }>} findings
 * @param {Array<{ frames: Array<{ file: string, lineno: number }>, count?: number, id?: string, message?: string, timestamp?: string, lastSeen?: string }>} runtimeEvents
 * @returns {{ correlated: Array, liveCount: number, summary: string }}
 */
function correlateFindings(findings, runtimeEvents) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { correlated: [], liveCount: 0, summary: 'No findings to correlate.' };
  }
  if (!Array.isArray(runtimeEvents) || runtimeEvents.length === 0) {
    return {
      correlated: findings,
      liveCount: 0,
      summary: 'No runtime events available for correlation.',
    };
  }

  const correlated = [];
  let liveCount = 0;

  for (const finding of findings) {
    const match = matchFinding(finding, runtimeEvents);
    if (match) {
      liveCount++;
      correlated.push({
        ...finding,
        liveInProd: true,
        liveEventCount: typeof match.count === 'number' ? match.count : 1,
        liveEventId: match.id || null,
        liveLastSeen: match.lastSeen || match.timestamp || null,
        liveMessage: match.message || null,
      });
    } else {
      correlated.push({ ...finding, liveInProd: false });
    }
  }

  // Sort: live findings first, then by severity
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
  correlated.sort((a, b) => {
    if (a.liveInProd !== b.liveInProd) return a.liveInProd ? -1 : 1;
    return (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  });

  const summary =
    liveCount === 0
      ? `No static findings matched production runtime errors (${runtimeEvents.length} event(s) checked).`
      : `${liveCount} finding(s) confirmed live in production — prioritise these first.`;

  return { correlated, liveCount, summary };
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderLiveBadge(finding) {
  if (!finding || !finding.liveInProd) return '';
  const count = finding.liveEventCount > 1 ? ` (${finding.liveEventCount}× in prod)` : '';
  return `🔥 **LIVE IN PROD**${count}`;
}

/**
 * Render a Markdown section summarising correlated live findings.
 *
 * @param {{ correlated: Array, liveCount: number, runtimeSource?: string }} opts
 */
function renderCorrelationSummary({ correlated, liveCount, runtimeSource }) {
  if (liveCount === 0) return '';

  const source = runtimeSource || 'runtime monitoring';
  const lines = [];
  lines.push('## 🔥 Live Production Correlation');
  lines.push('');
  lines.push(
    `The following ${liveCount} finding(s) have **active production errors** in the last 7 days` +
    ` (from ${source}). Fix these first.`,
  );
  lines.push('');
  lines.push('| Severity | Module | File | Line | Prod Events |');
  lines.push('|----------|--------|------|------|-------------|');

  for (const f of correlated.filter((f) => f.liveInProd)) {
    const lastSeen = f.liveLastSeen ? ` (last: ${String(f.liveLastSeen).slice(0, 10)})` : '';
    const count = f.liveEventCount;
    lines.push(
      `| ${f.severity} | ${f.module} | \`${f.file}\` | ${f.line ?? '?'} | ${count}${lastSeen} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  correlateFindings,
  matchFinding,
  normalisePath,
  pathsMatch,
  linesMatch,
  renderLiveBadge,
  renderCorrelationSummary,
  FILE_MATCH_FUZZ,
};
