/**
 * Phase 6.1.10 — "Fixed by GateTest" public registry store.
 *
 * Every PR that GateTest ships is logged here for social proof + the
 * public registry page at /fixes. Unlike scan_fingerprint (privacy-first),
 * this table stores public-safe data only: the repo's public name, the PR
 * URL (already public on GitHub), tier, and issue counts.
 *
 * Privacy contract:
 *   - repo_name = owner/repo from the public GitHub URL — already public.
 *   - pr_url = the GitHub PR URL — already public.
 *   - NO source code, NO file paths, NO secret values.
 *   - message is an optional short human-readable summary (≤500 chars).
 *
 * Pattern: stateless helpers that accept a sql tagged-template so tests can
 * inject a fake-sql. Safe for Vercel serverless.
 */

const PAGE_SIZE = 50;

async function ensureFixesTable(sql) {
  if (typeof sql !== 'function') throw new Error('ensureFixesTable: sql is required');
  await sql`
    CREATE TABLE IF NOT EXISTS fixes_log (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      repo_name   TEXT NOT NULL,
      pr_url      TEXT NOT NULL,
      tier        TEXT NOT NULL DEFAULT 'full',
      errors_fixed   INTEGER NOT NULL DEFAULT 0,
      warnings_fixed INTEGER NOT NULL DEFAULT 0,
      modules_fired  TEXT[] NOT NULL DEFAULT '{}',
      message     TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_fixes_log_created   ON fixes_log (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_fixes_log_repo      ON fixes_log (repo_name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_fixes_log_tier      ON fixes_log (tier)`;
}

/**
 * Record a delivered fix PR. Called by /api/scan/fix after pr_url is known.
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {string}   opts.repoName       e.g. "ccantynz-alt/Crontech"
 * @param {string}   opts.prUrl          full GitHub PR URL
 * @param {string}   [opts.tier]         quick|full|scan_fix|nuclear
 * @param {number}   [opts.errorsFixed]
 * @param {number}   [opts.warningsFixed]
 * @param {string[]} [opts.modulesFired]
 * @param {string}   [opts.message]      ≤500 char summary
 */
async function recordFix(opts) {
  const {
    sql, repoName, prUrl,
    tier = 'full',
    errorsFixed = 0,
    warningsFixed = 0,
    modulesFired = [],
    message = null,
  } = opts;
  if (typeof sql !== 'function') throw new Error('recordFix: sql is required');
  if (!repoName || !prUrl) throw new Error('recordFix: repoName and prUrl are required');

  const msg = message ? String(message).slice(0, 500) : null;

  await ensureFixesTable(sql);
  const rows = await sql`
    INSERT INTO fixes_log (repo_name, pr_url, tier, errors_fixed, warnings_fixed, modules_fired, message)
    VALUES (
      ${repoName},
      ${prUrl},
      ${tier},
      ${Math.max(0, Number(errorsFixed) || 0)},
      ${Math.max(0, Number(warningsFixed) || 0)},
      ${modulesFired},
      ${msg}
    )
    RETURNING id, created_at
  `;
  return rows[0] || null;
}

/**
 * Paginated list of fixes, newest first.
 */
async function listFixes(opts = {}) {
  const { sql, page = 1 } = opts;
  if (typeof sql !== 'function') throw new Error('listFixes: sql is required');
  await ensureFixesTable(sql);

  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const [rows, countRows] = await Promise.all([
    sql`
      SELECT id, created_at, repo_name, pr_url, tier,
             errors_fixed, warnings_fixed, modules_fired, message
      FROM fixes_log
      ORDER BY created_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `,
    sql`SELECT COUNT(*)::int AS total FROM fixes_log`,
  ]);

  const total = countRows[0]?.total ?? 0;
  return {
    fixes: rows,
    pagination: {
      page: pageNum,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    },
  };
}

/**
 * Aggregate stats for the stats banner on /fixes.
 */
async function getFixStats(opts = {}) {
  const { sql } = opts;
  if (typeof sql !== 'function') throw new Error('getFixStats: sql is required');
  await ensureFixesTable(sql);

  const rows = await sql`
    SELECT
      COUNT(*)::int                        AS total_fixes,
      COALESCE(SUM(errors_fixed),0)::int   AS total_errors_fixed,
      COALESCE(SUM(warnings_fixed),0)::int AS total_warnings_fixed,
      COUNT(DISTINCT repo_name)::int       AS unique_repos
    FROM fixes_log
  `;
  return rows[0] || { total_fixes: 0, total_errors_fixed: 0, total_warnings_fixed: 0, unique_repos: 0 };
}

module.exports = { ensureFixesTable, recordFix, listFixes, getFixStats, PAGE_SIZE };
