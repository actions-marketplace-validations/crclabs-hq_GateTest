/**
 * Phase 5.2.1 — dissent capture storage.
 *
 * The closed-feedback-loop sub-phase of THE 110% MANDATE. Every time a
 * customer rejects a fix, marks a finding as a false positive, lets a
 * fix PR rot without merging, or actively rolls back our commit — that
 * dissent signal flows into THIS table. The 5.2.2 cron job reads from
 * here weekly, computes per-module FP scores, and 5.2.3 uses those
 * scores to downgrade noisy modules for the customers who don't need
 * them.
 *
 * Without dissent capture, the brain (Phase 5.1) plateaus at first-day
 * quality. With it, every customer interaction makes the next one
 * smarter. This is the second compounding moat.
 *
 * Same design as scan-fingerprint-store / scan-queue-store / installation-
 * store: every helper takes the sql tagged-template via DI so tests inject
 * a fake-sql. Stateless. Serverless-safe.
 *
 * PRIVACY CONTRACT:
 *   - The dissent FROM repo is hashed (same hashRepoUrl as the brain).
 *   - The finding's pattern hash (NOT the message text) is what we
 *     correlate against.
 *   - Reviewer identity (the GitHub user who closed the PR) is hashed
 *     before storage, so we can detect "one bad reviewer skewing the
 *     signal" without storing the username.
 *   - Reasons are stored as enum values, not free-text.
 */

const crypto = require('crypto');

/**
 * The five recognised dissent kinds. Adding a new one bumps the schema
 * version implicitly via the seed in hashReviewer.
 */
const DISSENT_KINDS = Object.freeze({
  ROLLED_BACK: 'rolled_back',           // gate ran, accepted fix, customer reverted
  PR_CLOSED_UNMERGED: 'pr_closed_unmerged', // fix PR closed without merge after >7d
  FALSE_POSITIVE: 'false_positive',     // explicit thumbs-down on a finding
  FIX_REJECTED: 'fix_rejected',         // customer reverted only the fix commit
  COMMENT_DOWNVOTE: 'comment_downvote', // PR review comment with negative tone
});

const REVIEWER_HASH_SALT = 'gatetest:dissent_reviewer:v1';

/**
 * Hash a reviewer identity (GitHub login, email, etc.) for storage. We
 * never want the username in the database.
 */
function hashReviewer(reviewer) {
  if (!reviewer || typeof reviewer !== 'string') return null;
  return crypto
    .createHash('sha256')
    .update(`${REVIEWER_HASH_SALT}|${reviewer.toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Ensure the dissent table exists. Idempotent. Indexed for the read
 * shape the FP scorer (5.2.2) uses: GROUP BY (module, pattern_hash).
 */
async function ensureDissentTable(sql) {
  if (typeof sql !== 'function') throw new Error('ensureDissentTable: sql is required');
  await sql`CREATE TABLE IF NOT EXISTS dissent (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    repo_url_hash TEXT NOT NULL,
    module TEXT NOT NULL,
    pattern_hash TEXT,
    kind TEXT NOT NULL,
    reviewer_hash TEXT,
    fix_pr_number INT,
    notes TEXT
  )`;
  // Read shape #1: aggregate by (module, pattern_hash) over last N days.
  await sql`CREATE INDEX IF NOT EXISTS idx_dissent_module_pattern
    ON dissent (module, pattern_hash, created_at DESC)`;
  // Read shape #2: time-series queries for the operator dashboard.
  await sql`CREATE INDEX IF NOT EXISTS idx_dissent_created
    ON dissent (created_at DESC)`;
  // Read shape #3: "all dissent for this repo" (customer self-service).
  await sql`CREATE INDEX IF NOT EXISTS idx_dissent_repo
    ON dissent (repo_url_hash, created_at DESC)`;
  // Read shape #4: kind-aggregate dashboards.
  await sql`CREATE INDEX IF NOT EXISTS idx_dissent_kind
    ON dissent (kind, created_at DESC)`;
}

/**
 * Record a dissent event. Caller passes the cleartext repo URL (we
 * hash it) and optionally the reviewer (also hashed).
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {string} opts.repoUrl - cleartext URL; hashed before storage
 * @param {string} opts.module
 * @param {string} [opts.patternHash] - the (module, ruleId, file-ext) hash from scan-fingerprint
 * @param {string} opts.kind - one of DISSENT_KINDS values
 * @param {string} [opts.reviewer] - cleartext identity; hashed before storage
 * @param {number} [opts.fixPrNumber]
 * @param {string} [opts.notes] - free-text bounded to 500 chars
 */
async function recordDissent(opts) {
  const {
    sql, repoUrl, module, patternHash = null, kind, reviewer = null,
    fixPrNumber = null, notes = null,
  } = opts;
  if (typeof sql !== 'function') throw new Error('recordDissent: sql is required');
  if (!repoUrl) throw new Error('recordDissent: repoUrl is required');
  if (!module) throw new Error('recordDissent: module is required');
  if (!kind || !Object.values(DISSENT_KINDS).includes(kind)) {
    throw new Error(`recordDissent: kind must be one of ${Object.values(DISSENT_KINDS).join(', ')}`);
  }
  // Lazy import — avoids circular ref between dissent-store and scan-fingerprint-store.
   
  const { hashRepoUrl } = require('./scan-fingerprint-store.js');
  const repoUrlHash = hashRepoUrl(repoUrl);
  const reviewerHash = reviewer ? hashReviewer(reviewer) : null;
  const cappedNotes = typeof notes === 'string' ? notes.slice(0, 500) : null;

  const rows = await sql`
    INSERT INTO dissent (
      repo_url_hash, module, pattern_hash, kind, reviewer_hash, fix_pr_number, notes
    ) VALUES (
      ${repoUrlHash}, ${module}, ${patternHash}, ${kind}, ${reviewerHash}, ${fixPrNumber}, ${cappedNotes}
    )
    RETURNING id
  `;
  const id = rows && rows[0] ? rows[0].id : null;
  return { id };
}

/**
 * Aggregate dissent by (module, pattern_hash) over a recent window.
 * The FP scorer (5.2.2) consumes this output to compute confidence
 * scores. Result rows: { module, pattern_hash, dissent_count, distinct_reviewers, distinct_repos, kinds }.
 */
async function aggregateDissentByModulePattern(opts) {
  const { sql, daysBack = 30 } = opts;
  if (typeof sql !== 'function') throw new Error('aggregateDissentByModulePattern: sql is required');
  const rows = await sql`
    SELECT module, pattern_hash,
           COUNT(*)::int AS dissent_count,
           COUNT(DISTINCT reviewer_hash)::int AS distinct_reviewers,
           COUNT(DISTINCT repo_url_hash)::int AS distinct_repos,
           ARRAY_AGG(DISTINCT kind) AS kinds
    FROM dissent
    WHERE created_at > NOW() - (${daysBack} || ' days')::interval
    GROUP BY module, pattern_hash
    ORDER BY dissent_count DESC
  `;
  return rows || [];
}

/**
 * Return all dissent rows for a single repo. Used by customer-facing
 * "show me what dissent I've reported" view.
 */
async function listDissentForRepo(opts) {
  const { sql, repoUrl, limit = 100 } = opts;
  if (typeof sql !== 'function') throw new Error('listDissentForRepo: sql is required');
  if (!repoUrl) throw new Error('listDissentForRepo: repoUrl is required');
   
  const { hashRepoUrl } = require('./scan-fingerprint-store.js');
  const repoUrlHash = hashRepoUrl(repoUrl);
  const rows = await sql`
    SELECT id, created_at, module, pattern_hash, kind, fix_pr_number, notes
    FROM dissent
    WHERE repo_url_hash = ${repoUrlHash}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows || [];
}

/**
 * Top-level kinds breakdown for the operator dashboard.
 */
async function dissentKindsSummary(opts) {
  const { sql, daysBack = 30 } = opts;
  if (typeof sql !== 'function') throw new Error('dissentKindsSummary: sql is required');
  const rows = await sql`
    SELECT kind, COUNT(*)::int AS n
    FROM dissent
    WHERE created_at > NOW() - (${daysBack} || ' days')::interval
    GROUP BY kind
    ORDER BY n DESC
  `;
  return rows || [];
}

module.exports = {
  DISSENT_KINDS,
  REVIEWER_HASH_SALT,
  hashReviewer,
  ensureDissentTable,
  recordDissent,
  aggregateDissentByModulePattern,
  listDissentForRepo,
  dissentKindsSummary,
};
