/**
 * Scan history persistence helper.
 *
 * Records per-repo scan results so customers can see improvement over time:
 * "last week: 54 errors, today: 12 errors". Complements the cross-repo
 * intelligence fingerprint table (Phase 5.1) — where that table records
 * anonymised cohort-level patterns, THIS table records a customer's own
 * repo trend over time.
 *
 * PRIVACY CONTRACT (mirrors scan-fingerprint-store.js):
 *   - NO source code is stored.
 *   - NO file paths are stored.
 *   - NO secret values, env vars, or credentials.
 *   - Repo URL is stored as a salted sha256 hash — never the cleartext URL.
 *   - module_summary stores per-module { status, issues } only — no details.
 *   - Customer can request deletion of their history by repo URL.
 *
 * Design: every exported function receives a `sql` tagged-template so the
 * caller decides where the connection comes from. Stateless — safe for
 * serverless. Tests inject a fake-sql that records calls.
 */

const crypto = require('crypto');

const REPO_HASH_SALT = 'gatetest:scan_history:v1';

/**
 * Deterministically hash a repo URL for storage. Same URL → same hash on
 * every call so history lookups work without ever putting the URL in a
 * query log.
 */
function hashRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw new Error('hashRepoUrl: repoUrl is required and must be a string');
  }
  const normalised = repoUrl
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/:/g, '/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .replace(/\?.*$/, '');
  return crypto
    .createHash('sha256')
    .update(`${REPO_HASH_SALT}|${normalised}`)
    .digest('hex');
}

/**
 * Ensure the scan_history table and indexes exist. Idempotent.
 *
 * @param {Function} sql - tagged-template SQL function
 */
async function ensureScanHistoryTable(sql) {
  if (typeof sql !== 'function') {
    throw new Error('ensureScanHistoryTable: sql is required');
  }
  await sql`CREATE TABLE IF NOT EXISTS scan_history (
    id SERIAL PRIMARY KEY,
    repo_hash TEXT NOT NULL,
    tier TEXT NOT NULL,
    total_issues INTEGER NOT NULL,
    total_modules INTEGER NOT NULL,
    duration_ms INTEGER,
    scanned_at TIMESTAMPTZ DEFAULT NOW(),
    module_summary JSONB
  )`;
  await sql`CREATE INDEX IF NOT EXISTS scan_history_repo_hash_idx
    ON scan_history (repo_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS scan_history_scanned_at_idx
    ON scan_history (scanned_at)`;
}

/**
 * Insert a scan result row.
 *
 * @param {object} opts
 * @param {Function} opts.sql - tagged-template SQL function
 * @param {string} opts.repoUrl - cleartext URL; hashed before storage
 * @param {string} opts.tier
 * @param {number} opts.totalIssues
 * @param {number} opts.totalModules
 * @param {number} [opts.durationMs]
 * @param {Array}  [opts.modules] - array of { name, status, issues } — stored as module_summary
 * @returns {Promise<{id: number|null}>}
 */
async function saveScanResult(opts) {
  const {
    sql,
    repoUrl,
    tier,
    totalIssues,
    totalModules,
    durationMs = null,
    modules = [],
  } = opts;

  if (typeof sql !== 'function') throw new Error('saveScanResult: sql is required');
  if (!repoUrl) throw new Error('saveScanResult: repoUrl is required');
  if (!tier) throw new Error('saveScanResult: tier is required');
  if (typeof totalIssues !== 'number') throw new Error('saveScanResult: totalIssues must be a number');
  if (typeof totalModules !== 'number') throw new Error('saveScanResult: totalModules must be a number');

  const repoHash = hashRepoUrl(repoUrl);

  // Reduce modules to privacy-safe summary — only name, status, issues count.
  // No file paths, no details, no source code.
  const moduleSummary = modules.map((m) => ({
    name: m.name,
    status: m.status,
    issues: m.issues || 0,
  }));

  await ensureScanHistoryTable(sql);

  const rows = await sql`
    INSERT INTO scan_history (repo_hash, tier, total_issues, total_modules, duration_ms, module_summary)
    VALUES (
      ${repoHash},
      ${tier},
      ${totalIssues},
      ${totalModules},
      ${durationMs},
      ${JSON.stringify(moduleSummary)}::jsonb
    )
    RETURNING id
  `;
  const id = rows && rows[0] ? rows[0].id : null;
  return { id };
}

/**
 * Return scan history for a repo, newest first.
 *
 * @param {Function} sql - tagged-template SQL function
 * @param {string} repoUrl - cleartext URL; hashed before lookup
 * @param {number} [limit] - default 20
 * @returns {Promise<Array<{id, tier, total_issues, total_modules, duration_ms, scanned_at, module_summary}>>}
 */
async function getRepoHistory(sql, repoUrl, limit = 20) {
  if (typeof sql !== 'function') throw new Error('getRepoHistory: sql is required');
  if (!repoUrl) throw new Error('getRepoHistory: repoUrl is required');

  const repoHash = hashRepoUrl(repoUrl);

  await ensureScanHistoryTable(sql);

  const rows = await sql`
    SELECT id, tier, total_issues, total_modules, duration_ms, scanned_at, module_summary
    FROM scan_history
    WHERE repo_hash = ${repoHash}
    ORDER BY scanned_at DESC
    LIMIT ${limit}
  `;
  return rows || [];
}

module.exports = {
  REPO_HASH_SALT,
  hashRepoUrl,
  ensureScanHistoryTable,
  saveScanResult,
  getRepoHistory,
};
