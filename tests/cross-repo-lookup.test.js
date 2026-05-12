// ============================================================================
// CROSS-REPO-LOOKUP TEST — Phase 5.1.3 of THE 110% MANDATE
// ============================================================================
// Pure-function coverage for the cross-repo intelligence lookup helper.
// Verifies summarisation, prompt rendering, defensive null-returns when
// the brain has insufficient data, and integration with the nuclear
// diagnoser's prompt builder.
// ============================================================================

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  MIN_SAMPLE_SIZE,
  percentile,
  summariseSimilarScans,
  renderPriorArtPrompt,
  fetchPriorArt,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'cross-repo-lookup.js'));

const { buildDiagnosisPrompt } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'nuclear-diagnoser.js'
));

// ---------- shape ----------

test('MIN_SAMPLE_SIZE is at least 3 (tiny samples are noise, not signal)', () => {
  assert.ok(MIN_SAMPLE_SIZE >= 3);
});

// ---------- percentile ----------

describe('percentile', () => {
  it('returns the right values for a small sorted set', () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.0), 1);
  });

  it('handles unsorted input by sorting first', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  });

  it('returns 0 on empty / non-array', () => {
    assert.equal(percentile([], 0.5), 0);
    assert.equal(percentile(null, 0.5), 0);
  });
});

// ---------- summariseSimilarScans ----------

describe('summariseSimilarScans', () => {
  it('returns null when sample is below MIN_SAMPLE_SIZE', () => {
    const tiny = [{ total_findings: 5, module_findings: {}, fix_outcomes: {} }];
    assert.equal(summariseSimilarScans(tiny), null);
  });

  it('returns null on empty / non-array input', () => {
    assert.equal(summariseSimilarScans(null), null);
    assert.equal(summariseSimilarScans([]), null);
  });

  it('aggregates module fire-rate as a fraction of sample, sorted desc', () => {
    const rows = [
      { total_findings: 3, module_findings: { lint: { count: 2, patternHashes: ['h1'] }, secrets: { count: 1, patternHashes: ['h2'] } }, fix_outcomes: {} },
      { total_findings: 5, module_findings: { lint: { count: 3, patternHashes: ['h1'] } }, fix_outcomes: {} },
      { total_findings: 1, module_findings: { lint: { count: 1, patternHashes: ['h3'] } }, fix_outcomes: {} },
    ];
    const summary = summariseSimilarScans(rows);
    assert.equal(summary.sampleSize, 3);
    // lint fired in all 3 → rate 1.0
    assert.equal(summary.moduleFireRate[0].name, 'lint');
    assert.equal(summary.moduleFireRate[0].rate, 1);
    // secrets fired in 1 of 3 → rate 0.33...
    const secrets = summary.moduleFireRate.find((m) => m.name === 'secrets');
    assert.ok(secrets);
    assert.ok(secrets.rate < 0.5);
  });

  it('counts pattern frequency across the sample', () => {
    const rows = [
      { total_findings: 1, module_findings: { lint: { count: 1, patternHashes: ['hashA'] } }, fix_outcomes: {} },
      { total_findings: 1, module_findings: { lint: { count: 1, patternHashes: ['hashA', 'hashB'] } }, fix_outcomes: {} },
      { total_findings: 1, module_findings: { lint: { count: 1, patternHashes: ['hashA'] } }, fix_outcomes: {} },
    ];
    const summary = summariseSimilarScans(rows);
    const a = summary.topPatterns.find((p) => p.hash === 'hashA');
    const b = summary.topPatterns.find((p) => p.hash === 'hashB');
    assert.equal(a.count, 3);
    assert.equal(b.count, 1);
  });

  it('aggregates fix-success rate per module (only when ≥5 attempts)', () => {
    const rows = [
      { total_findings: 0, module_findings: {}, fix_outcomes: { lint: { attempted: 4, succeeded: 4 } } },
      { total_findings: 0, module_findings: {}, fix_outcomes: { lint: { attempted: 4, succeeded: 3 } } },
      { total_findings: 0, module_findings: {}, fix_outcomes: { lint: { attempted: 4, succeeded: 4 } } },
    ];
    const summary = summariseSimilarScans(rows);
    // 12 attempts ≥ 5 → included
    assert.ok(summary.moduleFixSuccessRate.lint);
    assert.equal(summary.moduleFixSuccessRate.lint.attempted, 12);
    assert.equal(summary.moduleFixSuccessRate.lint.succeeded, 11);
  });

  it('skips modules with fewer than 5 attempts (low-signal)', () => {
    const rows = [
      { total_findings: 0, module_findings: {}, fix_outcomes: { rare: { attempted: 1, succeeded: 1 } } },
      { total_findings: 0, module_findings: {}, fix_outcomes: { rare: { attempted: 1, succeeded: 0 } } },
      { total_findings: 0, module_findings: {}, fix_outcomes: { rare: { attempted: 1, succeeded: 1 } } },
    ];
    const summary = summariseSimilarScans(rows);
    assert.equal(summary.moduleFixSuccessRate.rare, undefined);
  });

  it('handles malformed rows defensively (no module_findings, etc.)', () => {
    const rows = [
      { total_findings: 0 },
      { total_findings: 0, module_findings: null },
      { total_findings: 0, module_findings: { lint: 'not an object' } },
    ];
    // Doesn't throw
    const summary = summariseSimilarScans(rows);
    assert.ok(summary);
  });

  it('computes overall fix rate', () => {
    const rows = [
      { total_findings: 10, total_fixed: 8, module_findings: {}, fix_outcomes: {} },
      { total_findings: 20, total_fixed: 15, module_findings: {}, fix_outcomes: {} },
      { total_findings: 10, total_fixed: 5, module_findings: {}, fix_outcomes: {} },
    ];
    const summary = summariseSimilarScans(rows);
    assert.equal(summary.overallFixRate, 28 / 40);
  });
});

// ---------- renderPriorArtPrompt ----------

describe('renderPriorArtPrompt', () => {
  it('returns null when summary is null', () => {
    assert.equal(renderPriorArtPrompt(null), null);
  });

  it('returns null when no module fires above the threshold', () => {
    const summary = {
      sampleSize: 10,
      moduleFireRate: [{ name: 'lint', rate: 0.1, count: 1 }], // below default 0.25
      topPatterns: [],
      moduleFixSuccessRate: {},
      medianTotalFindings: 5,
      p90TotalFindings: 10,
    };
    assert.equal(renderPriorArtPrompt(summary), null);
  });

  it('renders a multi-line prompt with sample size, module fire rates, and totals', () => {
    const summary = {
      sampleSize: 12,
      moduleFireRate: [
        { name: 'lint', rate: 0.92, count: 11 },
        { name: 'secrets', rate: 0.5, count: 6 },
      ],
      topPatterns: [],
      moduleFixSuccessRate: {
        lint: { rate: 0.88, attempted: 30, succeeded: 26 },
      },
      medianTotalFindings: 14,
      p90TotalFindings: 41,
    };
    const out = renderPriorArtPrompt(summary);
    assert.ok(out);
    assert.match(out, /^PRIOR-ART/);
    assert.match(out, /12 similar/);
    assert.match(out, /lint fired in 92%/);
    assert.match(out, /secrets fired in 50%/);
    assert.match(out, /median 14/);
    assert.match(out, /lint 88%/);
  });

  it('respects a custom minFireRate', () => {
    const summary = {
      sampleSize: 10,
      moduleFireRate: [{ name: 'lint', rate: 0.1, count: 1 }],
      topPatterns: [],
      moduleFixSuccessRate: {},
      medianTotalFindings: 1,
      p90TotalFindings: 1,
    };
    // Lower threshold → module shows up.
    const out = renderPriorArtPrompt(summary, { minFireRate: 0.05 });
    assert.ok(out);
    assert.match(out, /lint fired in 10%/);
  });

  it('caps shown modules to 5', () => {
    const moduleFireRate = [];
    for (let i = 0; i < 10; i++) {
      moduleFireRate.push({ name: `m${i}`, rate: 0.5, count: 5 });
    }
    const summary = {
      sampleSize: 10,
      moduleFireRate,
      topPatterns: [],
      moduleFixSuccessRate: {},
      medianTotalFindings: 0,
      p90TotalFindings: 0,
    };
    const out = renderPriorArtPrompt(summary);
    assert.match(out, /m0 fired/);
    assert.match(out, /m4 fired/);
    assert.doesNotMatch(out, /m5 fired/);
  });
});

// ---------- fetchPriorArt ----------

describe('fetchPriorArt', () => {
  it('returns null when fingerprint is missing', async () => {
    const out = await fetchPriorArt({});
    assert.equal(out, null);
  });

  it('returns null when findSimilarFingerprints throws (brain unavailable)', async () => {
    const out = await fetchPriorArt({
      fingerprint: { fingerprintSignature: 'sig', frameworkVersions: {} },
      findSimilarFingerprints: () => { throw new Error('db down'); },
      sql: () => Promise.resolve([]),
    });
    assert.equal(out, null);
  });

  it('returns null when sample is below MIN_SAMPLE_SIZE', async () => {
    const out = await fetchPriorArt({
      fingerprint: { fingerprintSignature: 'sig', frameworkVersions: {} },
      findSimilarFingerprints: async () => [{ total_findings: 1, module_findings: {} }],
      sql: () => Promise.resolve([]),
    });
    assert.equal(out, null);
  });

  it('returns context + summary when enough similar scans exist', async () => {
    const stubRows = [
      { total_findings: 5, module_findings: { lint: { count: 5, patternHashes: ['h1'] } }, fix_outcomes: {} },
      { total_findings: 7, module_findings: { lint: { count: 7, patternHashes: ['h1'] } }, fix_outcomes: {} },
      { total_findings: 3, module_findings: { lint: { count: 3, patternHashes: ['h1'] } }, fix_outcomes: {} },
    ];
    const out = await fetchPriorArt({
      fingerprint: { fingerprintSignature: 'sig', frameworkVersions: { next: '16' } },
      findSimilarFingerprints: async () => stubRows,
      sql: () => Promise.resolve([]),
    });
    assert.ok(out);
    assert.equal(out.sampleSize, 3);
    assert.match(out.context, /^PRIOR-ART/);
    assert.match(out.context, /lint fired in 100%/);
  });

  it('passes excludeRepoUrlHash through to the storage helper', async () => {
    let capturedOpts = null;
    await fetchPriorArt({
      fingerprint: { fingerprintSignature: 'sig', frameworkVersions: {} },
      repoUrlHash: 'my-hash',
      findSimilarFingerprints: async (opts) => { capturedOpts = opts; return []; },
      sql: () => Promise.resolve([]),
    });
    assert.equal(capturedOpts.excludeRepoUrlHash, 'my-hash');
  });
});

// ---------- nuclear-diagnoser integration ----------

describe('nuclear-diagnoser integration — buildDiagnosisPrompt accepts priorArt', () => {
  const finding = { module: 'secrets', severity: 'error', detail: 'hardcoded API key found in config' };

  it('omits prior-art block when priorArt is null', () => {
    const prompt = buildDiagnosisPrompt({ finding, hostname: 'x.com' });
    assert.doesNotMatch(prompt, /PRIOR-ART/);
  });

  it('appends prior-art block when supplied', () => {
    const priorArt = 'PRIOR-ART (12 similar codebases scanned recently):\n- secrets fired in 75% of similar repos';
    const prompt = buildDiagnosisPrompt({ finding, hostname: 'x.com', priorArt });
    assert.match(prompt, /PRIOR-ART \(12 similar/);
    assert.match(prompt, /secrets fired in 75%/);
    assert.match(prompt, /Use this prior-art ONLY to prioritise/);
    // Customer's actual finding still appears AFTER prior-art
    assert.match(prompt, /detail: hardcoded API key found in config/);
  });

  it('explicitly tells Claude to NOT copy from prior-art (anti-template guard)', () => {
    const prompt = buildDiagnosisPrompt({ finding, hostname: 'x.com', priorArt: 'PRIOR-ART:\n- foo' });
    assert.match(prompt, /Do not copy from it/);
  });
});
