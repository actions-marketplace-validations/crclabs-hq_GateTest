'use strict';

/**
 * Phase 6.1.10 — "Fixed by GateTest" public registry.
 *
 * Every PR that GateTest ships automatically gets logged here (opt-out on
 * request). The /fixes page renders these as a public feed — social proof
 * + marketing flywheel. Privacy: no source code stored; only the PR URL,
 * repo name (owner/name), module names, error/warning counts, and tier.
 */

const MAX_MESSAGE_CHARS = 280;
const PAGE_SIZE = 50;

// ─── Schema ───────────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS fix_registry (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    repo_name   TEXT NOT NULL,
    pr_url      TEXT NOT NULL UNIQUE,
    tier        TEXT NOT NULL DEFAULT 'full',
    errors_fixed  INTEGER NOT NULL DEFAULT 0,
    warnings_fixed INTEGER NOT NULL DEFAULT 0,
    modules_fired TEXT[],
    message     TEXT,
    is_public   BOOLEAN NOT NULL DEFAULT TRUE
  );
  CREATE INDEX IF NOT EXISTS fix_registry_created ON fix_registry (created_at DESC);
  CREATE INDEX IF NOT EXISTS fix_registry_public ON fix_registry (is_public, created_at DESC) WHERE is_public = TRUE;
`;

async function ensureTable(sql) {
  await sql.unsafe(CREATE_TABLE_SQL);
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Record a delivered fix in the registry.
 *
 * @param {import('./db').Sql} sql
 * @param {{ repoName, prUrl, tier, errorsFixed, warningsFixed, modulesFired, message }} opts
 * @returns {Promise<{ id: bigint } | null>}
 */
async function recordFix(sql, {
  repoName,
  prUrl,
  tier = 'full',
  errorsFixed = 0,
  warningsFixed = 0,
  modulesFired = [],
  message = null,
}) {
  if (!repoName || typeof repoName !== 'string') throw new Error('repoName is required');
  if (!prUrl || typeof prUrl !== 'string') throw new Error('prUrl is required');

  const safeMessage = message ? String(message).slice(0, MAX_MESSAGE_CHARS) : null;
  const safeModules = Array.isArray(modulesFired)
    ? modulesFired.filter((m) => typeof m === 'string').slice(0, 20)
    : [];

  await ensureTable(sql);

  const rows = await sql`
    INSERT INTO fix_registry
      (repo_name, pr_url, tier, errors_fixed, warnings_fixed, modules_fired, message)
    VALUES
      (${repoName}, ${prUrl}, ${tier}, ${errorsFixed}, ${warningsFixed}, ${safeModules}, ${safeMessage})
    ON CONFLICT (pr_url) DO UPDATE
      SET errors_fixed    = EXCLUDED.errors_fixed,
          warnings_fixed  = EXCLUDED.warnings_fixed,
          modules_fired   = EXCLUDED.modules_fired,
          message         = EXCLUDED.message
    RETURNING id
  `;

  return rows[0] || null;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * List public fixes in reverse-chronological order.
 *
 * @param {import('./db').Sql} sql
 * @param {{ page?, pageSize? }} opts
 * @returns {Promise<Array>}
 */
async function listPublicFixes(sql, { page = 1, pageSize = PAGE_SIZE } = {}) {
  await ensureTable(sql);
  const offset = (Math.max(1, page) - 1) * pageSize;

  return sql`
    SELECT
      id, created_at, repo_name, pr_url, tier,
      errors_fixed, warnings_fixed, modules_fired, message
    FROM fix_registry
    WHERE is_public = TRUE
    ORDER BY created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;
}

/**
 * Count total public fixes.
 */
async function countPublicFixes(sql) {
  await ensureTable(sql);
  const rows = await sql`SELECT COUNT(*)::int AS n FROM fix_registry WHERE is_public = TRUE`;
  return rows[0]?.n ?? 0;
}

/**
 * Get aggregate stats for the public feed banner.
 */
async function getFixStats(sql) {
  await ensureTable(sql);
  const rows = await sql`
    SELECT
      COUNT(*)::int                        AS total_fixes,
      COALESCE(SUM(errors_fixed), 0)::int  AS total_errors_fixed,
      COALESCE(SUM(warnings_fixed), 0)::int AS total_warnings_fixed,
      COUNT(DISTINCT repo_name)::int        AS unique_repos
    FROM fix_registry
    WHERE is_public = TRUE
  `;
  return rows[0] || { total_fixes: 0, total_errors_fixed: 0, total_warnings_fixed: 0, unique_repos: 0 };
}

/**
 * Opt a repo out of the public registry (privacy request).
 */
async function optOutRepo(sql, repoName) {
  if (!repoName) return;
  await ensureTable(sql);
  await sql`UPDATE fix_registry SET is_public = FALSE WHERE repo_name = ${repoName}`;
}

module.exports = {
  recordFix,
  listPublicFixes,
  countPublicFixes,
  getFixStats,
  optOutRepo,
  ensureTable,
  PAGE_SIZE,
  MAX_MESSAGE_CHARS,
};
