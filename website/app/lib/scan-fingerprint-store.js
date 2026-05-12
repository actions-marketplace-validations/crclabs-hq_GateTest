/**
 * Phase 5.1.1 — scan_fingerprint persistence helper.
 *
 * The fingerprint table is the foundation of cross-repo intelligence (the
 * "brain" sub-phase of THE 110% MANDATE). Every scan emits a privacy-respecting
 * fingerprint of the codebase shape — framework versions, language mix, per-
 * module finding-pattern hashes, fix outcomes. Future scans query this table
 * to surface lessons from similar codebases ("23% of Next 16 + Stripe repos
 * shipped this exact bug last quarter, here's the fix").
 *
 * PRIVACY CONTRACT:
 *   - NO source code is stored.
 *   - NO file paths are stored (filenames hashed only when used as features).
 *   - NO secret values, env vars, or credentials.
 *   - Repo URL is stored as a salted hash, never the cleartext URL.
 *   - Per-finding messages are reduced to category-level pattern hashes.
 *   - Customer can request deletion of their fingerprints by repo_url_hash.
 *
 * Design mirrors scan-queue-store.js / installation-store.js: every helper
 * receives the sql tagged-template so the caller decides where the connection
 * comes from. Stateless — safe for serverless. Tests inject a fake-sql that
 * records calls.
 */

const crypto = require('crypto');

/**
 * Stable salt for repo-URL hashing. NOT a secret — it's just a domain
 * separator so repo URLs can't be confused with other hashed identifiers
 * elsewhere in the system. The actual privacy guarantee comes from "we
 * never store the cleartext URL," not from this salt.
 */
const REPO_HASH_SALT = 'gatetest:scan_fingerprint:v1';

/**
 * Deterministically hash a repo URL for storage. Same URL → same hash on
 * every call so we can do "show all past fingerprints for this repo"
 * lookups without ever putting the URL in a query log.
 */
function hashRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw new Error('hashRepoUrl: repoUrl is required and must be a string');
  }
  // Normalise — strip protocol, trailing slash, .git suffix, query string —
  // so https://github.com/o/r.git and github.com/o/r/ collapse to one hash.
  const normalised = repoUrl
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/:/g, '/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .replace(/\?.*$/, '')
    .toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`${REPO_HASH_SALT}|${normalised}`)
    .digest('hex');
}

/**
 * Ensure the scan_fingerprint table exists. Idempotent. Includes the
 * GIN index on framework_versions so JSON-shaped lookups ("all repos
 * with next >= 16") run in milliseconds against millions of rows.
 *
 * @param {Function} sql - tagged-template SQL function
 */
async function ensureScanFingerprintTable(sql) {
  if (typeof sql !== 'function') {
    throw new Error('ensureScanFingerprintTable: sql is required');
  }
  await sql`CREATE TABLE IF NOT EXISTS scan_fingerprint (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    host TEXT NOT NULL DEFAULT 'gatetest.ai',
    repo_url_hash TEXT NOT NULL,
    tier TEXT NOT NULL,
    framework_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    language_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
    module_findings JSONB NOT NULL DEFAULT '{}'::jsonb,
    fix_outcomes JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_findings INT NOT NULL DEFAULT 0,
    total_fixed INT NOT NULL DEFAULT 0,
    duration_ms INT,
    fingerprint_signature TEXT NOT NULL
  )`;
  // Time-series queries: "scans in last 7 days for this host"
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_fingerprint_created
    ON scan_fingerprint (host, created_at DESC)`;
  // Repo-history queries: "every prior scan of this repo"
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_fingerprint_repo
    ON scan_fingerprint (repo_url_hash, created_at DESC)`;
  // Stack-similarity queries: "all repos with next 16 + react 19"
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_fingerprint_framework
    ON scan_fingerprint USING GIN (framework_versions)`;
  // Pattern-similarity queries: "all repos that hit this finding cluster"
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_fingerprint_module
    ON scan_fingerprint USING GIN (module_findings)`;
  // Tier-aggregate queries: "median findings for $99 customers this month"
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_fingerprint_tier
    ON scan_fingerprint (tier, created_at DESC)`;
  // Fast direct-signature lookup ("show me all repos that share my exact
  // shape today" — used by the brain's similarity-first lookup)
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_fingerprint_signature
    ON scan_fingerprint (fingerprint_signature)`;
}

/**
 * Insert a fingerprint row. Caller pre-computes the fingerprint via
 * scan-fingerprint.js (Phase 5.1.2) and passes the structured shape here.
 *
 * @param {object} opts
 * @param {Function} opts.sql - tagged-template SQL function
 * @param {string} opts.repoUrl - cleartext URL; hashed before storage
 * @param {string} opts.tier
 * @param {object} opts.frameworkVersions - { next: '16.2.4', react: '19', ... }
 * @param {object} opts.languageMix - { ts: 0.85, js: 0.10, json: 0.05 }
 * @param {object} opts.moduleFindings - per-module summary (count + pattern hashes)
 * @param {object} [opts.fixOutcomes] - per-module fix success rates
 * @param {number} [opts.totalFindings]
 * @param {number} [opts.totalFixed]
 * @param {number} [opts.durationMs]
 * @param {string} opts.fingerprintSignature - the stable hash for similarity lookup
 * @param {string} [opts.host] - default 'gatetest.ai'
 * @returns {Promise<{id: number}>}
 */
async function insertFingerprint(opts) {
  const {
    sql,
    repoUrl,
    tier,
    frameworkVersions = {},
    languageMix = {},
    moduleFindings = {},
    fixOutcomes = {},
    totalFindings = 0,
    totalFixed = 0,
    durationMs = null,
    fingerprintSignature,
    host = 'gatetest.ai',
  } = opts;

  if (typeof sql !== 'function') throw new Error('insertFingerprint: sql is required');
  if (!repoUrl) throw new Error('insertFingerprint: repoUrl is required');
  if (!tier) throw new Error('insertFingerprint: tier is required');
  if (!fingerprintSignature) throw new Error('insertFingerprint: fingerprintSignature is required');

  const repoUrlHash = hashRepoUrl(repoUrl);

  const rows = await sql`
    INSERT INTO scan_fingerprint (
      host, repo_url_hash, tier, framework_versions, language_mix,
      module_findings, fix_outcomes, total_findings, total_fixed,
      duration_ms, fingerprint_signature
    ) VALUES (
      ${host}, ${repoUrlHash}, ${tier},
      ${JSON.stringify(frameworkVersions)}::jsonb,
      ${JSON.stringify(languageMix)}::jsonb,
      ${JSON.stringify(moduleFindings)}::jsonb,
      ${JSON.stringify(fixOutcomes)}::jsonb,
      ${totalFindings}, ${totalFixed}, ${durationMs}, ${fingerprintSignature}
    )
    RETURNING id
  `;
  const id = rows && rows[0] ? rows[0].id : null;
  return { id };
}

/**
 * Find similar past fingerprints. Strategy:
 *   1. Same fingerprint_signature → exact-shape match (highest signal).
 *   2. Else fall back to "shares ≥ N framework versions" (good signal).
 *   3. Result is capped at `limit` and ordered by recency.
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {string} opts.fingerprintSignature
 * @param {object} [opts.frameworkVersions] - for fallback similarity
 * @param {string} [opts.excludeRepoUrlHash] - exclude prior scans of same repo
 * @param {number} [opts.limit] - default 5
 * @returns {Promise<Array>}
 */
async function findSimilarFingerprints(opts) {
  const {
    sql,
    fingerprintSignature,
    frameworkVersions = {},
    excludeRepoUrlHash = null,
    limit = 5,
  } = opts;

  if (typeof sql !== 'function') throw new Error('findSimilarFingerprints: sql is required');
  if (!fingerprintSignature) throw new Error('findSimilarFingerprints: fingerprintSignature is required');

  // Exact-signature match first.
  const exact = await sql`
    SELECT id, created_at, tier, framework_versions, language_mix,
           module_findings, fix_outcomes, total_findings, total_fixed
    FROM scan_fingerprint
    WHERE fingerprint_signature = ${fingerprintSignature}
      AND (${excludeRepoUrlHash}::text IS NULL OR repo_url_hash <> ${excludeRepoUrlHash})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  if (exact && exact.length >= limit) return exact;

  // Fallback: framework-overlap match. Only used if we don't have enough
  // exact matches. Uses the JSONB containment operator so the GIN index
  // serves the lookup.
  const remaining = limit - (exact ? exact.length : 0);
  if (remaining <= 0 || Object.keys(frameworkVersions).length === 0) {
    return exact || [];
  }
  // Strip patch versions for soft-match: keep only major.minor.
  const softFrameworks = {};
  for (const [k, v] of Object.entries(frameworkVersions)) {
    if (typeof v === 'string') {
      const m = v.match(/^(\d+)(?:\.(\d+))?/);
      softFrameworks[k] = m ? (m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]) : v;
    } else {
      softFrameworks[k] = v;
    }
  }
  const exactIds = (exact || []).map((r) => r.id);
  const fallback = await sql`
    SELECT id, created_at, tier, framework_versions, language_mix,
           module_findings, fix_outcomes, total_findings, total_fixed
    FROM scan_fingerprint
    WHERE framework_versions @> ${JSON.stringify(softFrameworks)}::jsonb
      AND fingerprint_signature <> ${fingerprintSignature}
      AND (${excludeRepoUrlHash}::text IS NULL OR repo_url_hash <> ${excludeRepoUrlHash})
      AND id <> ALL(${exactIds}::bigint[])
    ORDER BY created_at DESC
    LIMIT ${remaining}
  `;
  return [...(exact || []), ...(fallback || [])];
}

/**
 * Return aggregate stats for a framework — used by the intelligence
 * dashboard ("87th percentile of similar Next 16 + Stripe codebases").
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {object} opts.frameworkVersions
 * @param {number} [opts.daysBack] - default 30
 * @returns {Promise<{count: number, medianFindings: number, p90Findings: number, fixSuccessRate: number}>}
 */
async function getFingerprintStats(opts) {
  const { sql, frameworkVersions, daysBack = 30 } = opts;
  if (typeof sql !== 'function') throw new Error('getFingerprintStats: sql is required');
  if (!frameworkVersions || typeof frameworkVersions !== 'object') {
    throw new Error('getFingerprintStats: frameworkVersions is required');
  }
  const rows = await sql`
    SELECT
      COUNT(*)::int AS count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_findings)::int AS median_findings,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_findings)::int AS p90_findings,
      CASE WHEN SUM(total_findings) = 0 THEN 0
           ELSE (SUM(total_fixed)::float / SUM(total_findings)::float)
      END AS fix_success_rate
    FROM scan_fingerprint
    WHERE framework_versions @> ${JSON.stringify(frameworkVersions)}::jsonb
      AND created_at > NOW() - (${daysBack} || ' days')::interval
  `;
  const row = (rows && rows[0]) || {};
  return {
    count: row.count || 0,
    medianFindings: row.median_findings || 0,
    p90Findings: row.p90_findings || 0,
    fixSuccessRate: row.fix_success_rate || 0,
  };
}

/**
 * GDPR-style hard delete of every fingerprint for a given repo URL.
 * Customer-facing surface: "delete my history."
 */
async function deleteFingerprintsForRepo(opts) {
  const { sql, repoUrl } = opts;
  if (typeof sql !== 'function') throw new Error('deleteFingerprintsForRepo: sql is required');
  if (!repoUrl) throw new Error('deleteFingerprintsForRepo: repoUrl is required');
  const repoUrlHash = hashRepoUrl(repoUrl);
  const rows = await sql`
    DELETE FROM scan_fingerprint
    WHERE repo_url_hash = ${repoUrlHash}
    RETURNING id
  `;
  return { deleted: (rows || []).length };
}

module.exports = {
  REPO_HASH_SALT,
  hashRepoUrl,
  ensureScanFingerprintTable,
  insertFingerprint,
  findSimilarFingerprints,
  getFingerprintStats,
  deleteFingerprintsForRepo,
};
