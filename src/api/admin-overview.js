/**
 * GateTest Admin Overview API
 *
 * GET /api/admin/overview
 *
 * Returns a JSON summary of scan status across all monitored repos:
 *   - repos_monitored, total_scans_24h, total_issues_open,
 *     total_fixes_applied_7d
 *   - per-repo breakdown (last_scan, open_issues_by_severity,
 *     auto_fixes_7d)
 *   - stale_repos (no scan in >24h)
 *   - activity_feed (most-recent scan events)
 *
 * Auth: `Authorization: Bearer ${ADMIN_TOKEN}` header required.
 * The compare is timing-safe. Without ADMIN_TOKEN set in the env
 * the endpoint refuses all traffic (fail-closed).
 *
 * Data source: reads per-repo reports from `.gatetest/reports/` if
 * accessible. If none are found, returns a deterministic stub so
 * the endpoint always works (v2 will wire this to the real store).
 *
 * Framework: none — this exports a vanilla Node (req, res) handler
 * matching the style used by src/app-server.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPORTS_ROOT = process.env.GATETEST_REPORTS_DIR
  || path.resolve(__dirname, '..', '..', '.gatetest', 'reports');

const STALE_MS = 24 * 60 * 60 * 1000;       // 24h
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================
//  Auth
// ============================================================

function timingSafeBearerMatch(headerValue, expectedToken) {
  if (!expectedToken) return false;
  if (typeof headerValue !== 'string') return false;
  const prefix = 'Bearer ';
  if (!headerValue.startsWith(prefix)) return false;
  const presented = headerValue.slice(prefix.length);
  const a = Buffer.from(presented);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) {
    // Still do a compare to keep timing uniform-ish
    const filler = Buffer.alloc(b.length);
    crypto.timingSafeEqual(filler, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ============================================================
//  Data loading
// ============================================================

function safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * Reads scan reports. Expected layout (best-effort):
 *   .gatetest/reports/<owner>__<repo>/scan-<ts>.json
 *   .gatetest/reports/<owner>__<repo>/gatetest-report-latest.json
 *
 * Each report may include:
 *   { repo, ts, gatetest: { gateStatus }, summary: { ... },
 *     issues: [{severity}], fixes_applied: n }
 *
 * Missing files / unparseable JSON are skipped silently.
 */
function loadReportsFromDisk(root) {
  if (!fs.existsSync(root)) return null;
  let repoDirs;
  try {
    repoDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch (_e) {
    return null;
  }
  if (repoDirs.length === 0) return null;

  const repos = [];
  for (const dirent of repoDirs) {
    const repoDir = path.join(root, dirent.name);
    let files;
    try {
      files = fs.readdirSync(repoDir).filter((f) => f.endsWith('.json'));
    } catch (_e) {
      continue;
    }
    const reports = files
      .map((f) => safeReadJson(path.join(repoDir, f)))
      .filter(Boolean);
    if (reports.length === 0) continue;
    repos.push({
      name: dirent.name.replace('__', '/'),
      reports,
    });
  }
  return repos.length > 0 ? repos : null;
}

// ============================================================
//  Aggregation
// ============================================================

function emptySeverity() {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function tallyRepo(repo, now) {
  const sorted = repo.reports
    .slice()
    .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  const latest = sorted[0] || {};
  const open = emptySeverity();
  for (const issue of (latest.issues || [])) {
    const sev = (issue.severity || 'low').toLowerCase();
    if (open[sev] !== undefined) open[sev] += 1;
  }
  let fixes7d = 0;
  let scans24h = 0;
  for (const r of sorted) {
    const ts = new Date(r.ts || 0).getTime();
    if (!ts) continue;
    if (now - ts <= WINDOW_7D_MS) fixes7d += Number(r.fixes_applied || 0);
    if (now - ts <= WINDOW_24H_MS) scans24h += 1;
  }
  return {
    name: repo.name,
    last_scan: latest.ts || null,
    open_issues_by_severity: open,
    auto_fixes_7d: fixes7d,
    _scans_24h: scans24h,
  };
}

function buildOverviewFromReports(repoList) {
  const now = Date.now();
  const repos = repoList.map((r) => tallyRepo(r, now));

  let totalScans24h = 0;
  let totalOpen = 0;
  let totalFixes7d = 0;
  const stale = [];
  const activity = [];

  for (const r of repos) {
    totalScans24h += r._scans_24h;
    totalFixes7d += r.auto_fixes_7d;
    for (const k of Object.keys(r.open_issues_by_severity)) {
      totalOpen += r.open_issues_by_severity[k];
    }
    const lastTs = r.last_scan ? new Date(r.last_scan).getTime() : 0;
    if (!lastTs || now - lastTs > STALE_MS) stale.push(r.name);
    if (r.last_scan) {
      activity.push({
        ts: r.last_scan,
        repo: r.name,
        event: 'scan_completed',
        detail: `open=${totalOpenFor(r)} fixes7d=${r.auto_fixes_7d}`,
      });
    }
    delete r._scans_24h;
  }

  activity.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return {
    repos_monitored: repos.length,
    total_scans_24h: totalScans24h,
    total_issues_open: totalOpen,
    total_fixes_applied_7d: totalFixes7d,
    repos,
    stale_repos: stale,
    activity_feed: activity.slice(0, 20),
  };
}

function totalOpenFor(r) {
  const s = r.open_issues_by_severity;
  return s.critical + s.high + s.medium + s.low;
}

// ============================================================
//  Stub fallback (when no reports directory is accessible)
// ============================================================

function stubOverview() {
  const iso = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();
  return {
    repos_monitored: 3,
    total_scans_24h: 42,
    total_issues_open: 12,
    total_fixes_applied_7d: 18,
    repos: [
      {
        name: 'Gate-Test/Crontech',
        last_scan: iso(30 * 60 * 1000),
        open_issues_by_severity: { critical: 0, high: 1, medium: 3, low: 8 },
        auto_fixes_7d: 12,
      },
      {
        name: 'ccantynz-alt/GateTest',
        last_scan: iso(2 * 60 * 60 * 1000),
        open_issues_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
        auto_fixes_7d: 4,
      },
      {
        name: 'ccantynz-alt/DemoApp',
        last_scan: iso(18 * 60 * 60 * 1000),
        open_issues_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
        auto_fixes_7d: 2,
      },
    ],
    stale_repos: [],
    activity_feed: [
      {
        ts: iso(30 * 60 * 1000),
        repo: 'Gate-Test/Crontech',
        event: 'scan_completed',
        detail: '12 issues open, 12 auto-fixes in last 7d',
      },
      {
        ts: iso(2 * 60 * 60 * 1000),
        repo: 'ccantynz-alt/GateTest',
        event: 'scan_completed',
        detail: 'clean',
      },
      {
        ts: iso(18 * 60 * 60 * 1000),
        repo: 'ccantynz-alt/DemoApp',
        event: 'scan_completed',
        detail: 'clean',
      },
    ],
    _stub: true,
  };
}

// ============================================================
//  Public API
// ============================================================

function buildOverview() {
  const reports = loadReportsFromDisk(REPORTS_ROOT);
  if (!reports) return stubOverview();
  return buildOverviewFromReports(reports);
}

/**
 * Vanilla Node http handler. Matches the style used in
 * src/app-server.js — accepts (req, res) and writes the response
 * directly. Returns true if the request was handled, false otherwise,
 * so this can be composed into the existing server's router.
 */
function handler(req, res) {
  if (req.method !== 'GET' || req.url !== '/api/admin/overview') {
    return false;
  }

  const expected = process.env.ADMIN_TOKEN;
  if (!timingSafeBearerMatch(req.headers['authorization'], expected)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return true;
  }

  try {
    const body = buildOverview();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error', message: err.message }));
  }
  return true;
}

module.exports = {
  handler,
  // Exported for testing / reuse:
  buildOverview,
  buildOverviewFromReports,
  loadReportsFromDisk,
  stubOverview,
  timingSafeBearerMatch,
};
