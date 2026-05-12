// ============================================================================
// FP-TREND TEST — Phase 6.2.5 of THE 100-MOVES MASTER PLAN
// ============================================================================
// Pure-function coverage for the bucketing + trend-summary helper that
// powers the /admin/learning trend chart. The killer property:
// determinism — same input → same buckets across machines, across runs,
// regardless of host timezone.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  DEFAULT_DAYS_BACK,
  DEFAULT_BUCKET_DAYS,
  bucketKeyFor,
  bucketDissentRows,
  computeFpRateTrend,
  summariseTrend,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'fp-trend.js'));

// ---------- shape ----------

test('exports the constants the doc promises', () => {
  assert.strictEqual(typeof DEFAULT_DAYS_BACK, 'number');
  assert.strictEqual(typeof DEFAULT_BUCKET_DAYS, 'number');
  assert.ok(DEFAULT_DAYS_BACK >= 7);
  assert.ok(DEFAULT_BUCKET_DAYS >= 1);
});

// ---------- bucketKeyFor ----------

describe('bucketKeyFor', () => {
  it('returns null on missing / unparseable input', () => {
    assert.strictEqual(bucketKeyFor(null), null);
    assert.strictEqual(bucketKeyFor(undefined), null);
    assert.strictEqual(bucketKeyFor('not a date'), null);
  });

  it('snaps to bucket-start (UTC, day-aligned)', () => {
    // 2026-04-30T15:00:00Z falls in the same bucket as 2026-04-30T00:00:00Z (both Thursday)
    // For 7-day buckets snapped from epoch, both should land in the same key.
    const a = bucketKeyFor('2026-04-30T15:00:00Z', 7);
    const b = bucketKeyFor('2026-04-30T00:00:00Z', 7);
    assert.strictEqual(a, b);
    assert.match(a, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('different buckets when crossing the bucket boundary', () => {
    // ~10 days apart should land in different 7-day buckets
    const a = bucketKeyFor('2026-04-01T00:00:00Z', 7);
    const b = bucketKeyFor('2026-04-15T00:00:00Z', 7);
    assert.notStrictEqual(a, b);
  });

  it('day-aligned (bucketDays=1) — every distinct day is its own bucket', () => {
    const a = bucketKeyFor('2026-04-01T00:00:00Z', 1);
    const b = bucketKeyFor('2026-04-02T00:00:00Z', 1);
    assert.notStrictEqual(a, b);
  });
});

// ---------- bucketDissentRows ----------

describe('bucketDissentRows', () => {
  // Frozen "now" so tests don't drift when the system clock changes
  const NOW = new Date('2026-05-01T00:00:00Z').getTime();
  const frozenNow = () => NOW;

  it('returns [] for non-array input', () => {
    assert.deepStrictEqual(bucketDissentRows(null), []);
    assert.deepStrictEqual(bucketDissentRows(undefined), []);
  });

  it('groups rows by bucket and counts per-module + per-kind', () => {
    const rows = [
      { created_at: '2026-04-15T00:00:00Z', module: 'lint', kind: 'false_positive', repo_url_hash: 'r1' },
      { created_at: '2026-04-15T12:00:00Z', module: 'lint', kind: 'false_positive', repo_url_hash: 'r2' },
      { created_at: '2026-04-15T18:00:00Z', module: 'secrets', kind: 'rolled_back', repo_url_hash: 'r1' },
    ];
    const buckets = bucketDissentRows(rows, { bucketDays: 7, daysBack: 30, now: frozenNow });
    // Find the bucket that holds 2026-04-15
    const targetKey = bucketKeyFor('2026-04-15T00:00:00Z', 7);
    const target = buckets.find((b) => b.date === targetKey);
    assert.ok(target);
    assert.strictEqual(target.totalDissent, 3);
    assert.strictEqual(target.byModule.lint, 2);
    assert.strictEqual(target.byModule.secrets, 1);
    assert.strictEqual(target.byKind.false_positive, 2);
    assert.strictEqual(target.byKind.rolled_back, 1);
    assert.strictEqual(target.distinctRepos, 2); // r1 + r2
  });

  it('fills empty buckets within the window with zero counts (no chart gaps)', () => {
    const buckets = bucketDissentRows([], { bucketDays: 7, daysBack: 30, now: frozenNow });
    assert.ok(buckets.length >= 4); // 30 days / 7 = ~5 buckets
    for (const b of buckets) {
      assert.strictEqual(b.totalDissent, 0);
      assert.deepStrictEqual(b.byModule, {});
      assert.strictEqual(b.distinctRepos, 0);
    }
  });

  it('output is sorted oldest → newest', () => {
    const buckets = bucketDissentRows([], { bucketDays: 7, daysBack: 30, now: frozenNow });
    for (let i = 1; i < buckets.length; i++) {
      assert.ok(buckets[i].date >= buckets[i - 1].date, `bucket ${i} not sorted: ${buckets[i].date} < ${buckets[i - 1].date}`);
    }
  });

  it('skips rows with no created_at', () => {
    const buckets = bucketDissentRows(
      [{ module: 'lint', kind: 'false_positive' }],
      { bucketDays: 7, daysBack: 30, now: frozenNow }
    );
    const totals = buckets.reduce((s, b) => s + b.totalDissent, 0);
    assert.strictEqual(totals, 0);
  });

  it('coerces missing module / kind to "unknown"', () => {
    const rows = [
      { created_at: '2026-04-25T00:00:00Z' /* no module/kind */ },
    ];
    const buckets = bucketDissentRows(rows, { bucketDays: 7, daysBack: 30, now: frozenNow });
    const total = buckets.reduce((s, b) => s + b.totalDissent, 0);
    assert.strictEqual(total, 1);
    const allModules = buckets.flatMap((b) => Object.keys(b.byModule));
    assert.ok(allModules.includes('unknown'));
  });
});

// ---------- computeFpRateTrend ----------

describe('computeFpRateTrend', () => {
  it('null fpRate when bucket has zero dissent (chart should skip these)', () => {
    const buckets = [
      { date: '2026-04-01', totalDissent: 0, byModule: {}, byKind: {}, distinctRepos: 0 },
    ];
    const out = computeFpRateTrend(buckets);
    assert.strictEqual(out[0].fpRate, null);
  });

  it('computes a sensible rate when dissent exists', () => {
    const buckets = [
      { date: '2026-04-08', totalDissent: 10, byModule: {}, byKind: {}, distinctRepos: 3 },
    ];
    const out = computeFpRateTrend(buckets);
    assert.ok(typeof out[0].fpRate === 'number');
    assert.ok(out[0].fpRate >= 0 && out[0].fpRate <= 1);
  });

  it('returns [] for non-array input', () => {
    assert.deepStrictEqual(computeFpRateTrend(null), []);
    assert.deepStrictEqual(computeFpRateTrend(undefined), []);
  });
});

// ---------- summariseTrend ----------

describe('summariseTrend (the headline number for the dashboard)', () => {
  it('"no-data" when array is empty or every bucket is null-rate', () => {
    assert.strictEqual(summariseTrend([]).direction, 'no-data');
  });

  it('"insufficient-data" when only one bucket has data', () => {
    const buckets = [
      { date: '2026-04-08', fpRate: 0.5 },
      { date: '2026-04-15', fpRate: null },
    ];
    assert.strictEqual(summariseTrend(buckets).direction, 'insufficient-data');
  });

  it('"improving" when last bucket >5% lower than first', () => {
    const buckets = [
      { date: '2026-04-01', fpRate: 0.20 },
      { date: '2026-04-08', fpRate: 0.18 },
      { date: '2026-04-15', fpRate: 0.10 },
    ];
    const r = summariseTrend(buckets);
    assert.strictEqual(r.direction, 'improving');
    assert.ok(r.deltaPercent < -5);
  });

  it('"regressing" when last bucket >5% higher than first', () => {
    const buckets = [
      { date: '2026-04-01', fpRate: 0.10 },
      { date: '2026-04-15', fpRate: 0.20 },
    ];
    const r = summariseTrend(buckets);
    assert.strictEqual(r.direction, 'regressing');
    assert.ok(r.deltaPercent > 5);
  });

  it('"flat" when delta is within ±5%', () => {
    const buckets = [
      { date: '2026-04-01', fpRate: 0.20 },
      { date: '2026-04-15', fpRate: 0.205 },
    ];
    assert.strictEqual(summariseTrend(buckets).direction, 'flat');
  });
});

// ---------- determinism ----------

describe('determinism — same input → same output', () => {
  test('bucketDissentRows produces identical output across calls', () => {
    const NOW = new Date('2026-05-01T00:00:00Z').getTime();
    const rows = [
      { created_at: '2026-04-15T00:00:00Z', module: 'lint', kind: 'false_positive', repo_url_hash: 'r1' },
      { created_at: '2026-04-22T00:00:00Z', module: 'secrets', kind: 'rolled_back', repo_url_hash: 'r2' },
    ];
    const a = bucketDissentRows(rows, { bucketDays: 7, daysBack: 30, now: () => NOW });
    const b = bucketDissentRows(rows, { bucketDays: 7, daysBack: 30, now: () => NOW });
    assert.deepStrictEqual(a, b);
  });
});
