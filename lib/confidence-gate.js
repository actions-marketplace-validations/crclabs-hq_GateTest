/**
 * Confidence-Aware Reporting.
 *
 * Tier 1 Item 4 of the HYPER-AGGRESSIVE PRODUCT EVOLUTION ROADMAP.
 *
 * Aggregates the pair-review 4-axis rubric scores (correctness /
 * completeness / readability / testCoverage, each 1-5) into a single
 * confidence number in [0, 1], then gates that confidence against a
 * per-tier threshold. Only mark a fix as gate-blocking when the
 * confidence meets the threshold for the paid tier — permissive for
 * Quick (more volume), strict for Nuclear (surgical precision).
 *
 * Pure JS, CommonJS, Node stdlib only — directly testable under
 * `node --test` without any transform. Style matches scan-redaction.js.
 *
 * Five exports:
 *   1. TIER_THRESHOLDS       — per-tier confidence threshold map
 *   2. aggregateConfidence   — convert rubric scores → [0, 1] | null
 *   3. confidenceGate        — gate a single fix's confidence
 *   4. summariseConfidence   — one-line batch summary string
 *   5. formatConfidenceReport — markdown table for the PR body
 */

'use strict';

// ─── TIER_THRESHOLDS ─────────────────────────────────────────────────────────

/**
 * Per-tier confidence threshold.
 *
 * Quick:    0.50 — surface more issues, volume matters to the customer
 * Full:     0.70 — balanced quality/volume trade-off
 * scan_fix: 0.85 — strict: fixes ship without human review
 * nuclear:  0.90 — strictest: Nuclear customers pay for surgical precision
 *
 * @type {{ quick: number, full: number, scan_fix: number, nuclear: number }}
 */
const TIER_THRESHOLDS = {
  quick:    0.50,
  full:     0.70,
  scan_fix: 0.85,
  nuclear:  0.90,
};

// ─── WEIGHTS ─────────────────────────────────────────────────────────────────

/**
 * Correctness matters most (is the fix actually right?) followed by
 * completeness, then readability and test coverage equally.
 */
const WEIGHTS = {
  correctness:  0.40,
  completeness: 0.30,
  readability:  0.15,
  testCoverage: 0.15,
};

const AXES = Object.keys(WEIGHTS);
const SCORE_MAX = 5;

// ─── aggregateConfidence ─────────────────────────────────────────────────────

/**
 * Convert pair-review rubric scores into a single confidence value in [0, 1].
 *
 * @param {{ correctness: number, completeness: number, readability: number,
 *            testCoverage: number } | undefined | null} scores
 * @returns {number | null}  null when scores are unavailable or invalid
 */
function aggregateConfidence(scores) {
  if (scores == null || typeof scores !== 'object') return null;

  for (const axis of AXES) {
    if (typeof scores[axis] !== 'number') return null;
  }

  const weighted = AXES.reduce((sum, axis) => {
    return sum + scores[axis] * WEIGHTS[axis];
  }, 0);

  // Divide by SCORE_MAX to normalise to [0, 1]
  return weighted / SCORE_MAX;
}

// ─── confidenceGate ──────────────────────────────────────────────────────────

/**
 * Gate a single fix's confidence against the tier threshold.
 *
 * @param {{ confidence: number | null, tier: string }} options
 * @returns {{ allowed: boolean, threshold: number, reason: string }}
 */
function confidenceGate({ confidence, tier }) {
  const threshold = TIER_THRESHOLDS[tier] ?? TIER_THRESHOLDS.quick;

  if (confidence === null || confidence === undefined) {
    return {
      allowed:   true,
      threshold,
      reason:    'no-confidence-score-available — fix not blocked',
    };
  }

  if (confidence >= threshold) {
    return {
      allowed:   true,
      threshold,
      reason:    `confidence meets ${tier} threshold`,
    };
  }

  return {
    allowed:   false,
    threshold,
    reason:    `confidence ${confidence.toFixed(2)} below ${tier} threshold ${threshold}`,
  };
}

// ─── summariseConfidence ─────────────────────────────────────────────────────

/**
 * Produce a one-line batch summary across all fixes.
 *
 * @param {{ fixes: Array<{ file: string, scores?: object }>, tier: string }} options
 * @returns {string}
 */
function summariseConfidence({ fixes, tier }) {
  if (!Array.isArray(fixes) || fixes.length === 0) {
    return 'confidence: no fixes to evaluate';
  }

  const threshold = TIER_THRESHOLDS[tier] ?? TIER_THRESHOLDS.quick;

  const aggregated = fixes.map(f => aggregateConfidence(f.scores));
  const known      = aggregated.filter(c => c !== null);

  if (known.length === 0) {
    return 'confidence: no confidence data — gate disabled';
  }

  const gated  = aggregated.map((c, i) => confidenceGate({ confidence: c, tier }));
  const passed = gated.filter(g => g.allowed).length;
  const avg    = known.reduce((s, c) => s + c, 0) / known.length;
  const lowest = Math.min(...known);

  return (
    `confidence: ${passed}/${fixes.length} fixes met ${tier} threshold ${threshold}` +
    ` (avg ${avg.toFixed(2)}, lowest ${lowest.toFixed(2)})`
  );
}

// ─── formatConfidenceReport ──────────────────────────────────────────────────

/**
 * Render a markdown block for the PR body.
 *
 * @param {{ fixes: Array<{ file: string, scores?: object }>, tier: string }} options
 * @returns {string}
 */
function formatConfidenceReport({ fixes, tier }) {
  const threshold = TIER_THRESHOLDS[tier] ?? TIER_THRESHOLDS.quick;

  const lines = [
    `## Confidence-Aware Reporting (${tier})`,
    '',
    `Threshold for this tier: **${threshold}**`,
    '',
    '| File | Score | Decision |',
    '| --- | --- | --- |',
  ];

  if (!Array.isArray(fixes) || fixes.length === 0) {
    lines.push('| — | — | no fixes to evaluate |');
  } else {
    for (const fix of fixes) {
      const confidence = aggregateConfidence(fix.scores);
      const gate       = confidenceGate({ confidence, tier });
      const scoreStr   = confidence !== null ? confidence.toFixed(2) : 'n/a';
      const decision   = gate.allowed
        ? (confidence !== null ? '✅ ships' : '✅ ships (no score)')
        : '⚠️ below threshold';
      lines.push(`| ${fix.file} | ${scoreStr} | ${decision} |`);
    }
  }

  return lines.join('\n');
}

// ─── exports ─────────────────────────────────────────────────────────────────

module.exports = {
  TIER_THRESHOLDS,
  aggregateConfidence,
  confidenceGate,
  summariseConfidence,
  formatConfidenceReport,
};
