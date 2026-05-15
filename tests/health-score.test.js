'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  instanceMultiplier,
  scoreToGrade,
  computeHealthScore,
  renderHealthScoreCard,
  HIGH_SIGNAL_WEIGHTS,
  STANDARD_WEIGHTS,
  INSTANCE_MULTIPLIER_CAP,
} = require('../website/app/lib/health-score.js');

test('instanceMultiplier — 1 instance returns 1.0', () => {
  assert.equal(instanceMultiplier(1), 1);
});

test('instanceMultiplier — grows sub-linearly', () => {
  const m10 = instanceMultiplier(10);
  const m100 = instanceMultiplier(100);
  assert.ok(m10 < m100);
  assert.ok(m10 < 2);
  assert.ok(m100 <= INSTANCE_MULTIPLIER_CAP);
});

test('instanceMultiplier — caps at INSTANCE_MULTIPLIER_CAP', () => {
  assert.ok(instanceMultiplier(10000) <= INSTANCE_MULTIPLIER_CAP);
  assert.ok(instanceMultiplier(1e9) <= INSTANCE_MULTIPLIER_CAP);
});

test('instanceMultiplier — non-numeric input defaults to 1', () => {
  assert.equal(instanceMultiplier(null), 1);
  assert.equal(instanceMultiplier(undefined), 1);
  assert.equal(instanceMultiplier('not-a-number'), 1);
});

test('scoreToGrade — A ≥ 90', () => {
  assert.equal(scoreToGrade(100), 'A');
  assert.equal(scoreToGrade(90), 'A');
});

test('scoreToGrade — B 75-89', () => {
  assert.equal(scoreToGrade(89), 'B');
  assert.equal(scoreToGrade(75), 'B');
});

test('scoreToGrade — C 60-74', () => {
  assert.equal(scoreToGrade(74), 'C');
  assert.equal(scoreToGrade(60), 'C');
});

test('scoreToGrade — D 40-59', () => {
  assert.equal(scoreToGrade(59), 'D');
  assert.equal(scoreToGrade(40), 'D');
});

test('scoreToGrade — F below 40', () => {
  assert.equal(scoreToGrade(39), 'F');
  assert.equal(scoreToGrade(0), 'F');
});

test('computeHealthScore — empty clusters → 100/A', () => {
  const r = computeHealthScore([]);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.deductions.length, 0);
});

test('computeHealthScore — single warning cluster deducts modestly', () => {
  const r = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 1, ruleKey: 'r1' },
  ]);
  assert.equal(r.score, 100 - STANDARD_WEIGHTS.warning);
  assert.equal(r.grade, 'A'); // 98 is still A (≥ 90)
});

test('computeHealthScore — single high-signal error is severe', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'tls-security:expired-cert' },
  ]);
  assert.equal(r.score, 100 - HIGH_SIGNAL_WEIGHTS.error);
  assert.ok(r.score < 100);
});

test('computeHealthScore — score floors at 0 (cannot go negative)', () => {
  const clusters = [];
  for (let i = 0; i < 50; i++) {
    clusters.push({ severity: 'error', isHighSignal: true, count: 100, ruleKey: `r${i}` });
  }
  const r = computeHealthScore(clusters);
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'F');
});

test('computeHealthScore — info-severity clusters are not deducted', () => {
  const r = computeHealthScore([
    { severity: 'info', isHighSignal: false, count: 5, ruleKey: 'r1' },
  ]);
  assert.equal(r.score, 100);
});

test('computeHealthScore — instance count matters but sub-linearly', () => {
  const oneInstance = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 1, ruleKey: 'r1' },
  ]);
  const hundredInstances = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 100, ruleKey: 'r1' },
  ]);
  assert.ok(hundredInstances.score < oneInstance.score);
  // But the gap is small — log scale
  assert.ok(oneInstance.score - hundredInstances.score < 10);
});

test('computeHealthScore — deduction records list each rule', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'r1' },
    { severity: 'warning', isHighSignal: false, count: 5, ruleKey: 'r2' },
  ]);
  assert.equal(r.deductions.length, 2);
  assert.equal(r.deductions[0].ruleKey, 'r1');
  assert.equal(r.deductions[0].highSignal, true);
});

test('computeHealthScore — non-array safe', () => {
  const r = computeHealthScore(null);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
});

test('computeHealthScore — score is integer + always 0-100', () => {
  const r = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 3, ruleKey: 'r' },
  ]);
  assert.equal(Number.isInteger(r.score), true);
  assert.ok(r.score >= 0 && r.score <= 100);
});

test('renderHealthScoreCard — empty result returns empty string', () => {
  assert.equal(renderHealthScoreCard(null), '');
  assert.equal(renderHealthScoreCard({}), '');
});

test('renderHealthScoreCard — includes score + grade + emoji', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'r' },
  ]);
  const md = renderHealthScoreCard(r);
  assert.ok(md.includes(`Health Score: ${r.score} / 100`));
  assert.ok(md.includes(`Grade ${r.grade}`));
});

test('renderHealthScoreCard — table includes deduction rows', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'tls-security:expired-cert' },
    { severity: 'warning', isHighSignal: false, count: 3, ruleKey: 'web-headers:missing-csp' },
  ]);
  const md = renderHealthScoreCard(r);
  assert.ok(md.includes('tls-security:expired-cert'));
  assert.ok(md.includes('web-headers:missing-csp'));
  assert.ok(md.includes('🔥')); // high-signal flag
});

test('renderHealthScoreCard — caps the table at 20 rows', () => {
  const clusters = [];
  for (let i = 0; i < 30; i++) {
    clusters.push({ severity: 'warning', isHighSignal: false, count: 1, ruleKey: `rule-${i}` });
  }
  const r = computeHealthScore(clusters);
  const md = renderHealthScoreCard(r);
  const matchedRows = (md.match(/^\| \d+ \|/gm) || []).length;
  assert.equal(matchedRows, 20);
  assert.ok(md.includes('10 more deductions'));
});

test('computeHealthScore — realistic scenario: 1 critical TLS + 2 missing headers', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'tls-security:expired-cert' },
    { severity: 'warning', isHighSignal: false, count: 10, ruleKey: 'web-headers:missing-csp' },
    { severity: 'warning', isHighSignal: false, count: 5, ruleKey: 'cookie-security:missing-secure' },
  ]);
  // Lose: ~12 (high-signal error) + ~3 (warning x 10 instances) + ~2.5 (warning x 5) ≈ 17-18 pts
  // Score should be in the B/C zone (75-89 / 60-74)
  assert.ok(r.score >= 70 && r.score <= 90, `expected 70-90, got ${r.score}`);
});
