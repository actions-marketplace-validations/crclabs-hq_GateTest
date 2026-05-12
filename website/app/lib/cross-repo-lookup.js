/**
 * Phase 5.1.3 — cross-repo lookup helper.
 *
 * Sits between the storage layer (5.1.1) and the consumers — primarily
 * the Nuclear-tier diagnoser, secondarily the intelligence dashboard
 * (5.1.4). Given a fresh fingerprint:
 *   1. Query the brain (findSimilarFingerprints) for the top-N most-
 *      similar past scans of OTHER repos.
 *   2. Reduce them to a compact "prior-art context" — a multi-line
 *      string the diagnoser appends to its Claude prompt, OR a
 *      structured object the dashboard can render.
 *
 * The compact-context shape is the killer feature: every per-finding
 * Claude call gets context like
 *
 *     PRIOR-ART (from 47 similar codebases scanned in the last 30 days):
 *       - 32% had the same finding cluster (ssrf + hardcoded-url)
 *       - typical fix that worked: X, Y, Z
 *       - typical regression to avoid: A, B
 *
 * No competitor has this. Every customer scan makes the next one
 * smarter.
 *
 * Design principles:
 *   - Pure separation: this module BUILDS context strings; it does
 *     NOT call SQL itself. Caller injects sql + the storage helpers.
 *   - Defensive: when there's no DB, no similar fingerprints, or
 *     fewer than MIN_SAMPLE_SIZE matches, return null (no context
 *     beats fake context).
 *   - Privacy preserving: prior-art strings only mention pattern
 *     hashes + framework keys + counts. Never repo URLs, never code.
 */

const MIN_SAMPLE_SIZE = 3;

/**
 * Reduce a set of similar fingerprints into a compact stats summary.
 * Pure function — no I/O.
 *
 * Input: an array of past-fingerprint rows (shape from storage layer's
 *        findSimilarFingerprints — { framework_versions, module_findings,
 *        fix_outcomes, total_findings, ... }).
 *
 * Output: a structured summary the renderer below uses, OR null if
 *         the sample is too small to draw conclusions from.
 */
function summariseSimilarScans(rows) {
  if (!Array.isArray(rows) || rows.length < MIN_SAMPLE_SIZE) return null;

  const sampleSize = rows.length;

  // Per-module finding-frequency: how often did each module fire across
  // the sample? E.g. lint fired in 80% of similar repos.
  const moduleFireCount = {};
  // Pattern-hash frequency: how often did each pattern hash appear?
  const patternFireCount = {};
  // Per-module fix-success aggregate.
  const moduleFixAttempted = {};
  const moduleFixSucceeded = {};

  let totalFindingsSum = 0;
  let totalFixedSum = 0;

  for (const row of rows) {
    totalFindingsSum += row.total_findings || 0;
    totalFixedSum += row.total_fixed || 0;

    const mods = row.module_findings || {};
    const seenInRow = new Set();
    for (const [name, summary] of Object.entries(mods)) {
      if (!summary || typeof summary !== 'object') continue;
      if (summary.count > 0) seenInRow.add(name);
      const hashes = Array.isArray(summary.patternHashes) ? summary.patternHashes : [];
      for (const h of hashes) {
        patternFireCount[h] = (patternFireCount[h] || 0) + 1;
      }
    }
    for (const m of seenInRow) {
      moduleFireCount[m] = (moduleFireCount[m] || 0) + 1;
    }

    const outcomes = row.fix_outcomes || {};
    for (const [name, o] of Object.entries(outcomes)) {
      if (!o || typeof o !== 'object') continue;
      moduleFixAttempted[name] = (moduleFixAttempted[name] || 0) + (o.attempted || 0);
      moduleFixSucceeded[name] = (moduleFixSucceeded[name] || 0) + (o.succeeded || 0);
    }
  }

  // Module fire-rate as a fraction of sample, sorted desc.
  const moduleFireRate = Object.entries(moduleFireCount)
    .map(([name, count]) => ({ name, rate: count / sampleSize, count }))
    .sort((a, b) => b.rate - a.rate);

  // Top patterns by frequency, capped to top 10.
  const topPatterns = Object.entries(patternFireCount)
    .map(([hash, count]) => ({ hash, rate: count / sampleSize, count }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 10);

  // Per-module fix success rate, only when at least 5 attempts seen.
  const moduleFixSuccessRate = {};
  for (const name of Object.keys(moduleFixAttempted)) {
    const att = moduleFixAttempted[name];
    if (att < 5) continue;
    moduleFixSuccessRate[name] = {
      rate: moduleFixSucceeded[name] / att,
      attempted: att,
      succeeded: moduleFixSucceeded[name] || 0,
    };
  }

  return {
    sampleSize,
    medianTotalFindings: percentile(rows.map((r) => r.total_findings || 0), 0.5),
    p90TotalFindings: percentile(rows.map((r) => r.total_findings || 0), 0.9),
    overallFixRate: totalFindingsSum === 0 ? 0 : totalFixedSum / totalFindingsSum,
    moduleFireRate,
    topPatterns,
    moduleFixSuccessRate,
  };
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Floor(p * n) gives the discrete percentile index. p=0.5 of length 5
  // → idx 2 → median. p=0.9 → idx 4 → top value. Capped at length-1 to
  // handle p=1.0.
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * Render the summary as a compact prompt-context string the diagnoser
 * appends. Returns null if the summary is null OR if no module fires
 * above the inclusion threshold (no signal to share).
 *
 * Example output:
 *   PRIOR-ART (12 similar codebases scanned in the last 30d):
 *   - lint fired in 92% of similar repos (median 14 findings, p90 41)
 *   - secrets fired in 75% (median 2 findings)
 *   - top recurring patterns: hardcoded-key:ts, no-var:ts, sql-injection:py
 *   - typical fix success: lint 88%, secrets 71%
 */
function renderPriorArtPrompt(summary, opts = {}) {
  if (!summary) return null;
  const minFireRate = typeof opts.minFireRate === 'number' ? opts.minFireRate : 0.25;
  const lines = [];
  lines.push(`PRIOR-ART (${summary.sampleSize} similar codebases scanned recently):`);

  const significantModules = summary.moduleFireRate.filter((m) => m.rate >= minFireRate);
  if (significantModules.length === 0) {
    return null;
  }
  for (const m of significantModules.slice(0, 5)) {
    const pct = Math.round(m.rate * 100);
    lines.push(`- ${m.name} fired in ${pct}% of similar repos`);
  }

  if (summary.medianTotalFindings > 0) {
    lines.push(`- typical total findings: median ${summary.medianTotalFindings}, p90 ${summary.p90TotalFindings}`);
  }

  const fixEntries = Object.entries(summary.moduleFixSuccessRate || {})
    .map(([name, o]) => ({ name, rate: o.rate, attempted: o.attempted }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);
  if (fixEntries.length > 0) {
    const summary_ = fixEntries
      .map((e) => `${e.name} ${Math.round(e.rate * 100)}% (${e.attempted} attempts)`)
      .join(', ');
    lines.push(`- fix success rate by module: ${summary_}`);
  }

  return lines.join('\n');
}

/**
 * High-level facade: given a fingerprint, the storage helper, and the
 * sql client, run the lookup + summarise + render in one call. Returns
 * either { context: string, summary: object, sampleSize: number } when
 * useful prior-art was found, or null when there's nothing to add.
 *
 * @param {object} opts
 * @param {object} opts.fingerprint - the freshly-extracted fingerprint
 * @param {string} opts.repoUrlHash - hashed URL of the CURRENT repo (excluded from results)
 * @param {Function} opts.findSimilarFingerprints - inject from storage layer
 * @param {Function} opts.sql
 * @param {number} [opts.limit] - default 10 (more samples → better stats)
 * @returns {Promise<{context: string, summary: object, sampleSize: number} | null>}
 */
async function fetchPriorArt(opts) {
  const {
    fingerprint,
    repoUrlHash,
    findSimilarFingerprints,
    sql,
    limit = 10,
  } = opts;

  if (!fingerprint || !fingerprint.fingerprintSignature) return null;
  if (typeof findSimilarFingerprints !== 'function') return null;
  if (typeof sql !== 'function') return null;

  let rows;
  try {
    rows = await findSimilarFingerprints({
      sql,
      fingerprintSignature: fingerprint.fingerprintSignature,
      frameworkVersions: fingerprint.frameworkVersions || {},
      excludeRepoUrlHash: repoUrlHash || null,
      limit,
    });
  } catch {
    // Brain unavailable — never block the diagnoser, just skip prior-art.
    return null;
  }

  const summary = summariseSimilarScans(rows);
  if (!summary) return null;

  const context = renderPriorArtPrompt(summary);
  if (!context) return null;

  return {
    context,
    summary,
    sampleSize: summary.sampleSize,
  };
}

module.exports = {
  MIN_SAMPLE_SIZE,
  percentile,
  summariseSimilarScans,
  renderPriorArtPrompt,
  fetchPriorArt,
};
