// ============================================================================
// MODULE-CONFIDENCE TEST — Phase 5.2.2 of THE 110% MANDATE
// ============================================================================
// Pure-function coverage for the FP scorer + storage + cron entry-point.
// The math is tested deterministically — no I/O. The storage uses the
// fake-sql harness mirroring scan-fingerprint-store / dissent-store.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
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
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'module-confidence.js'));

function makeFakeSql(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fakeSql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    const next = queue.length > 0 ? queue.shift() : [];
    return Promise.resolve(next);
  };
  fakeSql.calls = calls;
  return fakeSql;
}

// ---------- shape ----------

test('exports the constants the FP scorer doc promises', () => {
  assert.strictEqual(typeof VOLUME_FLOOR_LIFT, 'number');
  assert.strictEqual(typeof MIN_SAMPLE_FOR_FULL_PENALTY, 'number');
  assert.strictEqual(MAX_SCORE, 1.0);
  assert.strictEqual(MIN_SCORE, 0.0);
});

// ---------- computeConfidenceScore ----------

describe('computeConfidenceScore', () => {
  it('returns 1.0 when there is no data at all (default optimistic)', () => {
    assert.strictEqual(computeConfidenceScore({ dissentCount: 0, totalFindings: 0 }), 1.0);
    assert.strictEqual(computeConfidenceScore({}), 1.0);
  });

  it('returns max score when there are findings but zero dissent', () => {
    const score = computeConfidenceScore({
      dissentCount: 0, distinctReviewers: 0, distinctRepos: 0,
      totalFindings: 100, totalFixSucceeded: 80,
    });
    assert.ok(score >= 0.99, `expected ~1.0, got ${score}`);
  });

  it('drops the score sharply when dissent fraction is high AND spread is high', () => {
    const score = computeConfidenceScore({
      dissentCount: 80, distinctReviewers: 80, distinctRepos: 80,
      totalFindings: 100, totalFixSucceeded: 0,
    });
    // 80% dissent across 80 distinct customers — clearly noisy
    assert.ok(score < 0.5, `expected < 0.5, got ${score}`);
  });

  it('keeps score relatively high when dissent is concentrated (one grumpy customer)', () => {
    // Same dissent COUNT but only 1 distinct reviewer + 1 distinct repo
    const concentrated = computeConfidenceScore({
      dissentCount: 80, distinctReviewers: 1, distinctRepos: 1,
      totalFindings: 100, totalFixSucceeded: 0,
    });
    const spread = computeConfidenceScore({
      dissentCount: 80, distinctReviewers: 80, distinctRepos: 80,
      totalFindings: 100, totalFixSucceeded: 0,
    });
    assert.ok(concentrated > spread,
      `concentrated dissent (${concentrated}) should out-score spread dissent (${spread})`);
  });

  it('lifts tiny-sample scores back toward 1.0 (volume floor)', () => {
    // 1 dissent, 1 finding — tiny sample, shouldn't be condemned
    const tiny = computeConfidenceScore({
      dissentCount: 1, distinctReviewers: 1, distinctRepos: 1,
      totalFindings: 1, totalFixSucceeded: 0,
    });
    // 50 dissent, 50 findings, 50 distinct customers — same RATIO,
    // but enough volume to matter
    const big = computeConfidenceScore({
      dissentCount: 50, distinctReviewers: 50, distinctRepos: 50,
      totalFindings: 50, totalFixSucceeded: 0,
    });
    assert.ok(tiny > big,
      `tiny-sample score (${tiny}) should be lifted above big-sample (${big})`);
  });

  it('clamps to [0, 1] even with adversarial input', () => {
    const negativeFindings = computeConfidenceScore({
      dissentCount: 1000, distinctReviewers: 1000, distinctRepos: 1000,
      totalFindings: -50, totalFixSucceeded: 0,
    });
    assert.ok(negativeFindings >= 0 && negativeFindings <= 1, `score must be in [0,1]: ${negativeFindings}`);

    const overflow = computeConfidenceScore({
      dissentCount: 0, totalFindings: 100, totalFixSucceeded: 999999,
    });
    assert.ok(overflow >= 0 && overflow <= 1, `score must be clamped to 1.0: ${overflow}`);
  });

  it('high fix-success rate lifts score modestly even with some dissent', () => {
    const noFix = computeConfidenceScore({
      dissentCount: 5, distinctReviewers: 5, distinctRepos: 5,
      totalFindings: 50, totalFixSucceeded: 0,
    });
    const greatFix = computeConfidenceScore({
      dissentCount: 5, distinctReviewers: 5, distinctRepos: 5,
      totalFindings: 50, totalFixSucceeded: 50,
    });
    assert.ok(greatFix > noFix,
      `fix-success bonus should lift the score (${greatFix} vs ${noFix})`);
  });

  it('handles non-number inputs gracefully', () => {
    const score = computeConfidenceScore({
      dissentCount: 'five', distinctReviewers: null, totalFindings: undefined,
    });
    assert.ok(typeof score === 'number');
    assert.ok(!Number.isNaN(score));
  });

  it('is deterministic — same input → same output', () => {
    const inputs = { dissentCount: 30, distinctReviewers: 12, distinctRepos: 8, totalFindings: 200, totalFixSucceeded: 150 };
    const a = computeConfidenceScore(inputs);
    const b = computeConfidenceScore(inputs);
    assert.strictEqual(a, b);
  });
});

// ---------- recommendedAction ----------

describe('recommendedAction', () => {
  it('maps score ranges to four actions', () => {
    assert.strictEqual(recommendedAction(0.95), 'trust');
    assert.strictEqual(recommendedAction(0.85), 'trust');
    assert.strictEqual(recommendedAction(0.75), 'downgrade');
    assert.strictEqual(recommendedAction(0.65), 'downgrade');
    assert.strictEqual(recommendedAction(0.55), 'double-down');
    assert.strictEqual(recommendedAction(0.45), 'double-down');
    assert.strictEqual(recommendedAction(0.30), 'suppress');
    assert.strictEqual(recommendedAction(0.0), 'suppress');
  });

  it('defaults to trust on garbage input (we do not silently suppress)', () => {
    assert.strictEqual(recommendedAction(undefined), 'trust');
    assert.strictEqual(recommendedAction(null), 'trust');
    assert.strictEqual(recommendedAction(NaN), 'trust');
    assert.strictEqual(recommendedAction('high'), 'trust');
  });
});

// ---------- ensureModuleConfidenceTable ----------

describe('ensureModuleConfidenceTable', () => {
  it('issues CREATE TABLE with the expected columns + 3 indexes', async () => {
    const sql = makeFakeSql();
    await ensureModuleConfidenceTable(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS module_confidence/);
    assert.match(joined, /score NUMERIC\(4,3\) NOT NULL/);
    assert.match(joined, /UNIQUE \(module, pattern_hash\)/);
    assert.match(joined, /idx_module_confidence_module/);
    assert.match(joined, /idx_module_confidence_updated/);
    assert.match(joined, /idx_module_confidence_low_score/);
  });

  it('every CREATE uses IF NOT EXISTS', async () => {
    const sql = makeFakeSql();
    await ensureModuleConfidenceTable(sql);
    for (const c of sql.calls) {
      assert.match(c.text, /IF NOT EXISTS/);
    }
  });

  it('throws when sql is missing', async () => {
    await assert.rejects(() => ensureModuleConfidenceTable(undefined), /sql is required/);
  });
});

// ---------- upsertModuleConfidence ----------

describe('upsertModuleConfidence', () => {
  it('issues INSERT ... ON CONFLICT DO UPDATE with all the right columns', async () => {
    const sql = makeFakeSql([[{ id: 7 }]]);
    await upsertModuleConfidence({
      sql,
      module: 'lint',
      patternHash: 'abc',
      score: 0.72,
      dissentCount: 12,
      distinctReviewers: 8,
      distinctRepos: 5,
      totalFindings: 100,
      totalFixSucceeded: 80,
    });
    const text = sql.calls[0].text;
    assert.match(text, /INSERT INTO module_confidence/);
    assert.match(text, /ON CONFLICT \(module, pattern_hash\) DO UPDATE/);
    assert.match(text, /score = EXCLUDED.score/);
  });

  it('returns the id from RETURNING', async () => {
    const sql = makeFakeSql([[{ id: 42 }]]);
    const result = await upsertModuleConfidence({
      sql, module: 'lint', score: 0.9,
    });
    assert.strictEqual(result.id, 42);
  });

  it('rejects when required fields missing', async () => {
    await assert.rejects(
      () => upsertModuleConfidence({ sql: makeFakeSql([[]]), score: 0.5 }),
      /module is required/
    );
    await assert.rejects(
      () => upsertModuleConfidence({ sql: makeFakeSql([[]]), module: 'lint' }),
      /score must be a number/
    );
  });
});

// ---------- getConfidenceScore ----------

describe('getConfidenceScore', () => {
  it('returns default optimistic score when no data exists', async () => {
    const sql = makeFakeSql([[]]);
    const result = await getConfidenceScore({ sql, module: 'lint' });
    assert.strictEqual(result.score, 1.0);
    assert.strictEqual(result.action, 'trust');
    assert.strictEqual(result.source, 'default');
  });

  it('returns the stored score when one exists', async () => {
    // 0.7 is in the [0.65, 0.85) "downgrade" band
    const sql = makeFakeSql([[{ score: 0.7, updated_at: '2026-04-29' }]]);
    const result = await getConfidenceScore({ sql, module: 'lint', patternHash: 'abc' });
    assert.strictEqual(result.score, 0.7);
    assert.strictEqual(result.action, 'downgrade');
    assert.strictEqual(result.source, 'db');
  });

  it('action follows the score → 0.6 maps to double-down (below the downgrade threshold)', async () => {
    const sql = makeFakeSql([[{ score: 0.6, updated_at: '2026-04-29' }]]);
    const result = await getConfidenceScore({ sql, module: 'lint', patternHash: 'abc' });
    assert.strictEqual(result.action, 'double-down');
  });

  it('falls back from (module, patternHash) to (module, NULL)', async () => {
    // First lookup empty, second lookup has the module-level row
    const sql = makeFakeSql([[], [{ score: 0.5, updated_at: '2026-04-29' }]]);
    const result = await getConfidenceScore({ sql, module: 'lint', patternHash: 'abc' });
    assert.strictEqual(result.score, 0.5);
    assert.strictEqual(result.source, 'db');
    assert.strictEqual(sql.calls.length, 2);
  });

  it('rejects when sql or module missing', async () => {
    await assert.rejects(
      () => getConfidenceScore({ module: 'lint' }),
      /sql is required/
    );
    await assert.rejects(
      () => getConfidenceScore({ sql: makeFakeSql() }),
      /module is required/
    );
  });
});

// ---------- refreshModuleConfidence ----------

describe('refreshModuleConfidence', () => {
  it('reads dissent aggregates and upserts a row per (module, pattern)', async () => {
    // First call → aggregateDissentByModulePattern returns 2 rows
    // Subsequent → 2× upserts each return an id
    const sql = makeFakeSql([
      [
        { module: 'lint', pattern_hash: 'h1', dissent_count: 30, distinct_reviewers: 12, distinct_repos: 8, kinds: ['false_positive'] },
        { module: 'secrets', pattern_hash: null, dissent_count: 5, distinct_reviewers: 3, distinct_repos: 3, kinds: ['rolled_back'] },
      ],
      [{ id: 1 }],
      [{ id: 2 }],
    ]);
    const result = await refreshModuleConfidence({ sql, daysBack: 30 });
    assert.strictEqual(result.updated, 2);
    assert.strictEqual(result.scanned, 2);

    // First call is the dissent aggregate
    assert.match(sql.calls[0].text, /GROUP BY module, pattern_hash/);
    // Subsequent calls are the upserts
    assert.match(sql.calls[1].text, /INSERT INTO module_confidence/);
    assert.match(sql.calls[2].text, /INSERT INTO module_confidence/);
  });

  it('handles empty dissent gracefully', async () => {
    const sql = makeFakeSql([[]]);
    const result = await refreshModuleConfidence({ sql });
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.scanned, 0);
  });

  it('rejects when sql missing', async () => {
    await assert.rejects(() => refreshModuleConfidence({}), /sql is required/);
  });
});
