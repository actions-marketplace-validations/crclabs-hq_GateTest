/**
 * Phase 5.2.2 — per-module false-positive scorer + module_confidence storage.
 *
 * The brain in 5.1 builds knowledge across customers. The dissent store
 * in 5.2.1 captures their disagreements. This module is the ENGINE that
 * turns disagreement signal into a per-(module, pattern) confidence
 * score that 5.2.3 uses to downgrade noisy modules for customers who
 * don't need them.
 *
 * Three layers:
 *   1. Pure scoring function (computeConfidenceScore) — deterministic,
 *      fully unit-testable. Same inputs → same score, every time.
 *   2. Storage helper (module_confidence table) — same DI pattern as
 *      every other store in this codebase.
 *   3. Refresh-from-dissent (refreshModuleConfidence) — the cron entry
 *      point. Reads dissent aggregates, computes scores, upserts the
 *      whole table in one pass.
 *
 * SCORING MODEL:
 *
 *   Confidence score is in [0.0, 1.0]. Higher = trust this module's
 *   findings, surface them as-is. Lower = noisy on this pattern,
 *   downgrade or suppress.
 *
 *   Inputs:
 *     dissentCount       — # of dissent rows for (module, pattern)
 *     distinctReviewers  — # of distinct reviewers who dissented
 *     distinctRepos      — # of distinct repos who dissented
 *     totalFindings      — # of times we found this pattern across all scans
 *     totalFixSucceeded  — # of times the fix loop succeeded on this pattern
 *
 *   Score = base × spreadFactor × volumeFloor
 *
 *     base       = 1.0 - (dissentCount / max(totalFindings, dissentCount))
 *                  i.e. fraction of findings NOT followed by dissent.
 *     spread     = stronger penalty when many distinct reviewers / repos
 *                  reported the same issue (single grumpy customer is noise;
 *                  20 customers reporting it is signal).
 *     volumeFloor = lift small-sample scores up so a brand-new pattern
 *                   with 1 dissent isn't immediately suppressed.
 *
 *   The exact math is unit-tested below — see tests/module-confidence.test.js.
 *
 * USAGE:
 *
 *   await refreshModuleConfidence({ sql, daysBack: 30 });
 *     // weekly cron: aggregates dissent, recomputes every (module, pattern)
 *
 *   const score = await getConfidenceScore({ sql, module, patternHash });
 *     // per-finding lookup at scan time (5.2.3)
 *
 *   await ensureModuleConfidenceTable(sql);
 *     // one-shot table migration on first run
 */

const VOLUME_FLOOR_LIFT = 0.2; // never drop below score = base + lift × (1 - base) for tiny samples
const MIN_SAMPLE_FOR_FULL_PENALTY = 10; // below this, we lift the score back up
const MAX_SCORE = 1.0;
const MIN_SCORE = 0.0;

/**
 * Pure scoring function. Takes raw dissent + outcome counts, returns
 * the (module, pattern) confidence score in [0.0, 1.0]. Deterministic.
 *
 * @param {object} input
 * @param {number} input.dissentCount       Total dissent rows.
 * @param {number} input.distinctReviewers  Unique reviewers in dissent.
 * @param {number} input.distinctRepos      Unique repos in dissent.
 * @param {number} input.totalFindings      Total times we found this pattern.
 * @param {number} [input.totalFixSucceeded] Times the fix loop succeeded.
 * @returns {number} score in [0.0, 1.0]
 */
function computeConfidenceScore(input) {
  const dissentCount = Number(input?.dissentCount) || 0;
  const distinctReviewers = Number(input?.distinctReviewers) || 0;
  const distinctRepos = Number(input?.distinctRepos) || 0;
  const totalFindings = Number(input?.totalFindings) || 0;
  const totalFixSucceeded = Number(input?.totalFixSucceeded) || 0;

  // No findings, no dissent → unknown. Default to optimistic (we
  // trust the module until proven otherwise).
  if (totalFindings === 0 && dissentCount === 0) return MAX_SCORE;

  // Base score: fraction of findings NOT followed by dissent. We use
  // max(totalFindings, dissentCount) as the denominator so dissent
  // can never out-strip findings (defensive against state drift).
  const denom = Math.max(totalFindings, dissentCount, 1);
  const base = 1.0 - dissentCount / denom;

  // Spread penalty: more distinct reviewers/repos → stronger signal that
  // this is real noise (not one grumpy customer). We compute spread as
  // the average of (reviewers/dissent) and (repos/dissent), capped at 1.0.
  let spread = 1.0;
  if (dissentCount > 0) {
    const reviewerSpread = distinctReviewers / dissentCount;
    const repoSpread = distinctRepos / dissentCount;
    spread = Math.min(1.0, (reviewerSpread + repoSpread) / 2);
  }
  // When spread is 1.0 (every dissent from a different reviewer + repo),
  // the base score stands. When spread is low (one customer hammering
  // the same finding 50 times), we lift the score back toward 1.0.
  const spreadAdjusted = base + (1 - spread) * (1 - base);

  // Volume floor: small samples are noisy in either direction. We lift
  // tiny-sample scores back toward 1.0 by VOLUME_FLOOR_LIFT × distance-to-1.
  const totalSample = totalFindings + dissentCount;
  let volumeFloored = spreadAdjusted;
  if (totalSample < MIN_SAMPLE_FOR_FULL_PENALTY) {
    const lift = VOLUME_FLOOR_LIFT * (1 - spreadAdjusted) * ((MIN_SAMPLE_FOR_FULL_PENALTY - totalSample) / MIN_SAMPLE_FOR_FULL_PENALTY);
    volumeFloored = spreadAdjusted + lift;
  }

  // Fix-success bonus: if the auto-fix worked the majority of the time,
  // even a high-dissent pattern earns some confidence back (the dissent
  // may be about the FIX shape, not the finding's correctness).
  let fixBonus = 0;
  if (totalFindings > 0 && totalFixSucceeded > 0) {
    const fixRate = Math.min(1.0, totalFixSucceeded / totalFindings);
    fixBonus = 0.05 * fixRate; // small lift, never dominates
  }

  return clamp(volumeFloored + fixBonus, MIN_SCORE, MAX_SCORE);
}

/**
 * Map a confidence score to a recommended severity adjustment for
 * 5.2.3's confidence-aware reporting. Pure function.
 *
 * Score ≥ 0.85 → "trust"        (surface as-is)
 * Score ≥ 0.65 → "downgrade"    (error → warning)
 * Score ≥ 0.45 → "double-down"  (warning → info)
 * Score < 0.45 → "suppress"     (drop entirely for this customer)
 */
function recommendedAction(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'trust';
  if (score >= 0.85) return 'trust';
  if (score >= 0.65) return 'downgrade';
  if (score >= 0.45) return 'double-down';
  return 'suppress';
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// ----------------------------------------------------------------------
// Storage layer
// ----------------------------------------------------------------------

/**
 * Idempotent migration. Same DI pattern as every other store.
 */
async function ensureModuleConfidenceTable(sql) {
  if (typeof sql !== 'function') throw new Error('ensureModuleConfidenceTable: sql is required');
  await sql`CREATE TABLE IF NOT EXISTS module_confidence (
    id BIGSERIAL PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    module TEXT NOT NULL,
    pattern_hash TEXT,
    score NUMERIC(4,3) NOT NULL,
    dissent_count INT NOT NULL DEFAULT 0,
    distinct_reviewers INT NOT NULL DEFAULT 0,
    distinct_repos INT NOT NULL DEFAULT 0,
    total_findings INT NOT NULL DEFAULT 0,
    total_fix_succeeded INT NOT NULL DEFAULT 0,
    sample_window_days INT NOT NULL DEFAULT 30,
    UNIQUE (module, pattern_hash)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_module_confidence_module
    ON module_confidence (module, score DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_module_confidence_updated
    ON module_confidence (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_module_confidence_low_score
    ON module_confidence (score) WHERE score < 0.65`;
}

/**
 * Upsert a single (module, pattern) row.
 */
async function upsertModuleConfidence(opts) {
  const {
    sql, module, patternHash, score, dissentCount, distinctReviewers,
    distinctRepos, totalFindings = 0, totalFixSucceeded = 0,
    sampleWindowDays = 30,
  } = opts;
  if (typeof sql !== 'function') throw new Error('upsertModuleConfidence: sql is required');
  if (!module) throw new Error('upsertModuleConfidence: module is required');
  if (typeof score !== 'number') throw new Error('upsertModuleConfidence: score must be a number');

  const rows = await sql`
    INSERT INTO module_confidence (
      module, pattern_hash, score, dissent_count, distinct_reviewers,
      distinct_repos, total_findings, total_fix_succeeded, sample_window_days, updated_at
    ) VALUES (
      ${module}, ${patternHash || null}, ${score}, ${dissentCount || 0},
      ${distinctReviewers || 0}, ${distinctRepos || 0},
      ${totalFindings || 0}, ${totalFixSucceeded || 0}, ${sampleWindowDays}, NOW()
    )
    ON CONFLICT (module, pattern_hash) DO UPDATE SET
      score = EXCLUDED.score,
      dissent_count = EXCLUDED.dissent_count,
      distinct_reviewers = EXCLUDED.distinct_reviewers,
      distinct_repos = EXCLUDED.distinct_repos,
      total_findings = EXCLUDED.total_findings,
      total_fix_succeeded = EXCLUDED.total_fix_succeeded,
      sample_window_days = EXCLUDED.sample_window_days,
      updated_at = NOW()
    RETURNING id
  `;
  const id = rows && rows[0] ? rows[0].id : null;
  return { id };
}

/**
 * Per-finding lookup. Returns the score + recommended action, or
 * 1.0 / 'trust' if we have no data yet.
 */
async function getConfidenceScore(opts) {
  const { sql, module, patternHash = null } = opts;
  if (typeof sql !== 'function') throw new Error('getConfidenceScore: sql is required');
  if (!module) throw new Error('getConfidenceScore: module is required');

  // Try exact (module, pattern_hash) match first; fall back to
  // (module, NULL pattern_hash) when no per-pattern data is in.
  let rows;
  if (patternHash) {
    rows = await sql`
      SELECT score, updated_at FROM module_confidence
      WHERE module = ${module} AND pattern_hash = ${patternHash}
      LIMIT 1
    `;
    if (!rows || rows.length === 0) {
      rows = await sql`
        SELECT score, updated_at FROM module_confidence
        WHERE module = ${module} AND pattern_hash IS NULL
        LIMIT 1
      `;
    }
  } else {
    rows = await sql`
      SELECT score, updated_at FROM module_confidence
      WHERE module = ${module} AND pattern_hash IS NULL
      LIMIT 1
    `;
  }

  if (!rows || rows.length === 0) {
    return { score: MAX_SCORE, action: 'trust', stale: false, source: 'default' };
  }
  const score = Number(rows[0].score) || MAX_SCORE;
  return {
    score,
    action: recommendedAction(score),
    stale: false,
    source: 'db',
  };
}

/**
 * The cron entry-point. Reads the dissent aggregate (from 5.2.1) and
 * upserts every (module, pattern) row in module_confidence.
 *
 * Designed to run weekly. Costs O(distinct (module, pattern) pairs in
 * dissent) — tiny.
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {number} [opts.daysBack=30]
 * @returns {Promise<{ updated: number, scanned: number }>}
 */
async function refreshModuleConfidence(opts) {
  const { sql, daysBack = 30 } = opts;
  if (typeof sql !== 'function') throw new Error('refreshModuleConfidence: sql is required');

  // Lazy import — keeps the store free of cross-imports.
   
  const { aggregateDissentByModulePattern } = require('./dissent-store.js');

  const dissentRows = await aggregateDissentByModulePattern({ sql, daysBack });

  let updated = 0;
  for (const row of dissentRows) {
    // For now we don't have per-(module, pattern) total findings yet —
    // that comes when 5.1.4's dashboard back-fills via the fingerprint
    // store. Use a conservative totalFindings estimate of dissentCount
    // × 5 so the score reflects "1 in 5 of these is dissented" baseline.
    const conservativeTotal = Math.max(row.dissent_count || 0, (row.dissent_count || 0) * 5);
    const score = computeConfidenceScore({
      dissentCount: row.dissent_count || 0,
      distinctReviewers: row.distinct_reviewers || 0,
      distinctRepos: row.distinct_repos || 0,
      totalFindings: conservativeTotal,
      totalFixSucceeded: 0,
    });
    await upsertModuleConfidence({
      sql,
      module: row.module,
      patternHash: row.pattern_hash || null,
      score,
      dissentCount: row.dissent_count || 0,
      distinctReviewers: row.distinct_reviewers || 0,
      distinctRepos: row.distinct_repos || 0,
      totalFindings: conservativeTotal,
      totalFixSucceeded: 0,
      sampleWindowDays: daysBack,
    });
    updated += 1;
  }

  return { updated, scanned: dissentRows.length };
}

module.exports = {
  VOLUME_FLOOR_LIFT,
  MIN_SAMPLE_FOR_FULL_PENALTY,
  MAX_SCORE,
  MIN_SCORE,
  computeConfidenceScore,
  recommendedAction,
  ensureModuleConfidenceTable,
  upsertModuleConfidence,
  getConfidenceScore,
  refreshModuleConfidence,
};
