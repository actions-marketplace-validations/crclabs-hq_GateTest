'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');

const {
  TIER_THRESHOLDS,
  aggregateConfidence,
  confidenceGate,
  summariseConfidence,
  formatConfidenceReport,
} = require('../lib/confidence-gate');

// ─── aggregateConfidence ──────────────────────────────────────────────────────

test('aggregateConfidence: perfect score (5,5,5,5) returns 1.0', () => {
  const result = aggregateConfidence({
    correctness: 5, completeness: 5, readability: 5, testCoverage: 5,
  });
  assert.equal(result, 1.0);
});

test('aggregateConfidence: uniform mid score (3,3,3,3) returns 0.6', () => {
  const result = aggregateConfidence({
    correctness: 3, completeness: 3, readability: 3, testCoverage: 3,
  });
  // weighted sum = 3*(0.4+0.3+0.15+0.15) = 3*1.0 = 3.0; /5 = 0.6
  assert.equal(result, 0.6);
});

test('aggregateConfidence: undefined returns null', () => {
  assert.equal(aggregateConfidence(undefined), null);
});

test('aggregateConfidence: null returns null', () => {
  assert.equal(aggregateConfidence(null), null);
});

test('aggregateConfidence: missing axis returns null', () => {
  assert.equal(
    aggregateConfidence({ correctness: 4, completeness: 3, readability: 3 }),
    null,
  );
});

test('aggregateConfidence: correctness weighted highest — (5,1,1,1) > (1,5,1,1)', () => {
  // correctness-heavy: 5*0.4 + 1*0.3 + 1*0.15 + 1*0.15 = 2.0+0.3+0.15+0.15 = 2.6  /5 = 0.52
  // completeness-heavy: 1*0.4 + 5*0.3 + 1*0.15 + 1*0.15 = 0.4+1.5+0.15+0.15 = 2.2  /5 = 0.44
  const corrHeavy = aggregateConfidence({ correctness: 5, completeness: 1, readability: 1, testCoverage: 1 });
  const compHeavy = aggregateConfidence({ correctness: 1, completeness: 5, readability: 1, testCoverage: 1 });
  assert.ok(corrHeavy > compHeavy, `expected ${corrHeavy} > ${compHeavy}`);
});

// ─── confidenceGate ───────────────────────────────────────────────────────────

test('confidenceGate: allows when confidence >= threshold', () => {
  const result = confidenceGate({ confidence: 0.87, tier: 'scan_fix' });
  assert.equal(result.allowed, true);
  assert.equal(result.threshold, TIER_THRESHOLDS.scan_fix);
  assert.ok(result.reason.includes('scan_fix'));
});

test('confidenceGate: blocks when confidence < threshold', () => {
  const result = confidenceGate({ confidence: 0.60, tier: 'scan_fix' });
  assert.equal(result.allowed, false);
  assert.equal(result.threshold, TIER_THRESHOLDS.scan_fix);
  assert.ok(result.reason.includes('0.60'));
  assert.ok(result.reason.includes('0.85'));
});

test('confidenceGate: permissive (allowed: true) when confidence is null', () => {
  const result = confidenceGate({ confidence: null, tier: 'nuclear' });
  assert.equal(result.allowed, true);
  assert.ok(result.reason.includes('no-confidence-score-available'));
});

test('confidenceGate: defaults to quick threshold for unknown tier', () => {
  const result = confidenceGate({ confidence: 0.51, tier: 'unknown-tier' });
  assert.equal(result.threshold, TIER_THRESHOLDS.quick);
  assert.equal(result.allowed, true);   // 0.51 >= 0.50
});

test('confidenceGate: blocks at quick threshold for unknown tier when below 0.50', () => {
  const result = confidenceGate({ confidence: 0.49, tier: 'unknown-tier' });
  assert.equal(result.threshold, TIER_THRESHOLDS.quick);
  assert.equal(result.allowed, false);
});

// ─── summariseConfidence ──────────────────────────────────────────────────────

test('summariseConfidence: 10 mixed-score fixes returns expected string', () => {
  // 8 fixes that clear scan_fix threshold (0.85), 2 that don't
  const highScores = { correctness: 5, completeness: 5, readability: 4, testCoverage: 4 };
  // 5*0.4+5*0.3+4*0.15+4*0.15 = 2+1.5+0.6+0.6 = 4.7/5 = 0.94
  const lowScores  = { correctness: 3, completeness: 3, readability: 3, testCoverage: 3 };
  // = 0.60

  const fixes = [
    ...Array.from({ length: 8 }, (_, i) => ({ file: `src/a${i}.ts`, scores: highScores })),
    ...Array.from({ length: 2 }, (_, i) => ({ file: `src/b${i}.ts`, scores: lowScores  })),
  ];

  const summary = summariseConfidence({ fixes, tier: 'scan_fix' });

  assert.ok(summary.startsWith('confidence:'), `got: ${summary}`);
  assert.ok(summary.includes('8/10'), `expected 8/10 in: ${summary}`);
  assert.ok(summary.includes('scan_fix'), `tier name missing: ${summary}`);
  assert.ok(summary.includes('0.85'), `threshold missing: ${summary}`);
  assert.ok(summary.includes('avg'), `avg missing: ${summary}`);
  assert.ok(summary.includes('lowest'), `lowest missing: ${summary}`);
});

test('summariseConfidence: empty fixes returns graceful message', () => {
  const summary = summariseConfidence({ fixes: [], tier: 'full' });
  assert.ok(summary.includes('no fixes to evaluate'));
});

test('summariseConfidence: all-null scores returns gate-disabled message', () => {
  const fixes = [
    { file: 'src/a.ts' },
    { file: 'src/b.ts' },
  ];
  const summary = summariseConfidence({ fixes, tier: 'nuclear' });
  assert.ok(summary.includes('no confidence data'), `got: ${summary}`);
  assert.ok(summary.includes('gate disabled'), `got: ${summary}`);
});

// ─── formatConfidenceReport ───────────────────────────────────────────────────

test('formatConfidenceReport: returns markdown table with one row per fix', () => {
  const fixes = [
    { file: 'src/a.ts', scores: { correctness: 5, completeness: 5, readability: 5, testCoverage: 5 } },
    { file: 'src/b.ts', scores: { correctness: 2, completeness: 2, readability: 2, testCoverage: 2 } },
  ];

  const report = formatConfidenceReport({ fixes, tier: 'full' });

  // Header
  assert.ok(report.includes('## Confidence-Aware Reporting (full)'));
  assert.ok(report.includes('**0.7**'));

  // Table header row
  assert.ok(report.includes('| File | Score | Decision |'));

  // Two data rows — one pass, one fail
  const rows = report.split('\n').filter(l => l.startsWith('| src/'));
  assert.equal(rows.length, 2, `expected 2 data rows, got ${rows.length}`);

  const passRow = rows.find(r => r.includes('src/a.ts'));
  const failRow = rows.find(r => r.includes('src/b.ts'));

  assert.ok(passRow, 'row for src/a.ts present');
  assert.ok(failRow, 'row for src/b.ts present');

  assert.ok(passRow.includes('✅ ships'),           `pass row: ${passRow}`);
  assert.ok(failRow.includes('⚠️ below threshold'), `fail row: ${failRow}`);
});
