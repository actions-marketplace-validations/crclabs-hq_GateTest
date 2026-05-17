'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diffScans, shouldAlert, clusterKey } = require('../website/app/lib/scan-diff.js');
const { renderDriftAlert } = require('../website/app/lib/drift-alert-template.js');

function makeScan(opts) {
  return {
    targetUrl: opts.url || 'https://example.com',
    scannedAt: new Date().toISOString(),
    healthScore: { score: opts.score || 80, grade: opts.grade || 'B', summary: 'x' },
    findings: opts.findings || [],
    totalFindings: opts.totalFindings || (opts.findings ? opts.findings.length : 0),
    totalClusters: opts.findings ? opts.findings.length : 0,
    errorCount: (opts.findings || []).filter((f) => f.severity === 'error').length,
    warningCount: (opts.findings || []).filter((f) => f.severity === 'warning').length,
    infoCount: 0,
    preview: false,
    findings: opts.findings || [],
  };
}

function f(ruleKey, severity = 'warning', count = 1, highSignal = false) {
  return {
    ruleKey,
    severity,
    title: `Finding: ${ruleKey}`,
    body: '',
    module: 'm',
    instanceCount: count,
    highSignal,
  };
}

// ── diffScans ────────────────────────────────────────────────────────

test('diffScans — empty inputs return empty diff', () => {
  const r = diffScans({}, {});
  assert.equal(r.newFindings.length, 0);
  assert.equal(r.resolvedFindings.length, 0);
  assert.equal(r.persistentFindings.length, 0);
  assert.equal(r.scoreChange.delta, 0);
});

test('diffScans — finding in current but not baseline = new', () => {
  const baseline = makeScan({ findings: [f('a')] });
  const current = makeScan({ findings: [f('a'), f('b', 'error')] });
  const r = diffScans(baseline, current);
  assert.equal(r.newFindings.length, 1);
  assert.equal(r.newFindings[0].ruleKey, 'b');
  assert.equal(r.persistentFindings.length, 1);
  assert.equal(r.persistentFindings[0].current.ruleKey, 'a');
});

test('diffScans — finding in baseline but not current = resolved', () => {
  const baseline = makeScan({ findings: [f('a'), f('b')] });
  const current = makeScan({ findings: [f('a')] });
  const r = diffScans(baseline, current);
  assert.equal(r.resolvedFindings.length, 1);
  assert.equal(r.resolvedFindings[0].ruleKey, 'b');
});

test('diffScans — same rule in both with different counts records delta', () => {
  const baseline = makeScan({ findings: [f('a', 'warning', 3)] });
  const current = makeScan({ findings: [f('a', 'warning', 10)] });
  const r = diffScans(baseline, current);
  assert.equal(r.persistentFindings.length, 1);
  assert.equal(r.persistentFindings[0].countDelta, 7);
});

test('diffScans — health score delta + direction', () => {
  const baseline = makeScan({ score: 90, grade: 'A' });
  const current = makeScan({ score: 72, grade: 'C' });
  const r = diffScans(baseline, current);
  assert.equal(r.scoreChange.from, 90);
  assert.equal(r.scoreChange.to, 72);
  assert.equal(r.scoreChange.delta, -18);
  assert.equal(r.scoreChange.direction, 'down');
});

test('diffScans — flat direction within 1 pt', () => {
  const baseline = makeScan({ score: 80 });
  const current = makeScan({ score: 81 });
  const r = diffScans(baseline, current);
  assert.equal(r.scoreChange.direction, 'flat');
});

test('diffScans — regression flag when score drops > 3pts', () => {
  const baseline = makeScan({ score: 90, findings: [f('a')] });
  const current = makeScan({ score: 80, findings: [f('a')] });
  const r = diffScans(baseline, current);
  assert.equal(r.regression, true);
});

test('diffScans — regression flag when new error appears', () => {
  const baseline = makeScan({ score: 80 });
  const current = makeScan({ score: 79, findings: [f('new-err', 'error')] });
  const r = diffScans(baseline, current);
  assert.equal(r.regression, true);
});

test('diffScans — improvement flag when score climbs > 3pts and no new findings', () => {
  const baseline = makeScan({ score: 70, findings: [f('a', 'error'), f('b')] });
  const current = makeScan({ score: 85, findings: [f('a', 'error')] });
  const r = diffScans(baseline, current);
  assert.equal(r.improvement, true);
});

test('diffScans — countShift records err/warn deltas', () => {
  const baseline = makeScan({ findings: [f('a', 'error'), f('b', 'warning')] });
  const current = makeScan({ findings: [f('a', 'error'), f('c', 'error'), f('d', 'warning'), f('e', 'warning')] });
  const r = diffScans(baseline, current);
  assert.equal(r.countShift.errorDelta, 1);
  assert.equal(r.countShift.warningDelta, 1);
  assert.equal(r.countShift.totalClusterDelta, 2);
});

test('diffScans — high-signal new finding triggers regression', () => {
  const baseline = makeScan({ findings: [] });
  const current = makeScan({ findings: [f('crawl:broken-scripts', 'warning', 1, true)] });
  const r = diffScans(baseline, current);
  assert.equal(r.regression, true);
});

test('diffScans — new and resolved sorted by severity', () => {
  const baseline = makeScan({ findings: [f('a', 'warning'), f('b', 'error')] });
  const current = makeScan({ findings: [f('c', 'warning'), f('d', 'error')] });
  const r = diffScans(baseline, current);
  assert.equal(r.newFindings[0].severity, 'error');
  assert.equal(r.resolvedFindings[0].severity, 'error');
});

test('clusterKey — falls back to module:title when no ruleKey', () => {
  assert.equal(clusterKey({ module: 'm', title: 't' }), 'm:t');
});

// ── shouldAlert ──────────────────────────────────────────────────────

test('shouldAlert — no change → no alert', () => {
  const baseline = makeScan({ findings: [f('a')] });
  const current = makeScan({ findings: [f('a')] });
  const diff = diffScans(baseline, current);
  const a = shouldAlert(diff);
  assert.equal(a.shouldAlert, false);
});

test('shouldAlert — regression → alert', () => {
  const baseline = makeScan({ score: 85 });
  const current = makeScan({ score: 70, findings: [f('new-err', 'error')] });
  const diff = diffScans(baseline, current);
  const a = shouldAlert(diff);
  assert.equal(a.shouldAlert, true);
  assert.ok(a.reasons.length > 0);
});

test('shouldAlert — improvement → alert (share the win)', () => {
  const baseline = makeScan({ score: 70, findings: [f('a', 'error'), f('b')] });
  const current = makeScan({ score: 88, findings: [f('a', 'error')] });
  const diff = diffScans(baseline, current);
  assert.equal(shouldAlert(diff).shouldAlert, true);
});

test('shouldAlert — score drop of 5+ pts triggers alert even without new findings', () => {
  const baseline = makeScan({ score: 80, findings: [f('a')] });
  const current = makeScan({ score: 73, findings: [f('a')] });
  const diff = diffScans(baseline, current);
  assert.equal(shouldAlert(diff).shouldAlert, true);
});

// ── renderDriftAlert ─────────────────────────────────────────────────

test('renderDriftAlert — regression subject mentions score drop', () => {
  const baseline = makeScan({ score: 90, grade: 'A' });
  const current = makeScan({ score: 70, grade: 'C', findings: [f('a', 'error')] });
  const diff = diffScans(baseline, current);
  const r = renderDriftAlert({ targetUrl: 'https://example.com', customerName: 'Craig', diff });
  assert.ok(/dropped 20 points/.test(r.subject));
  assert.ok(r.markdown.includes('## Health Score'));
  assert.ok(r.markdown.includes('new issue'));
});

test('renderDriftAlert — improvement subject is positive', () => {
  const baseline = makeScan({ score: 60, findings: [f('a', 'error'), f('b')] });
  const current = makeScan({ score: 85, findings: [f('a', 'error')] });
  const diff = diffScans(baseline, current);
  const r = renderDriftAlert({ targetUrl: 'https://example.com', diff });
  assert.ok(/improved/i.test(r.subject));
});

test('renderDriftAlert — no-change subject is the weekly recap', () => {
  const baseline = makeScan({ findings: [f('a')] });
  const current = makeScan({ findings: [f('a')] });
  const diff = diffScans(baseline, current);
  const r = renderDriftAlert({ targetUrl: 'https://example.com', diff });
  assert.ok(/Weekly scan report/i.test(r.subject));
  assert.ok(/No change since last scan/i.test(r.markdown));
});

test('renderDriftAlert — includes unsubscribe link when supplied', () => {
  const baseline = makeScan({});
  const current = makeScan({});
  const diff = diffScans(baseline, current);
  const r = renderDriftAlert({ targetUrl: 'https://example.com', diff, unsubscribeUrl: 'https://gatetest.ai/u/abc' });
  assert.ok(r.markdown.includes('Unsubscribe'));
  assert.ok(r.markdown.includes('https://gatetest.ai/u/abc'));
});

test('renderDriftAlert — plain-text strips markdown decorators', () => {
  const baseline = makeScan({});
  const current = makeScan({ findings: [f('a', 'error')] });
  const diff = diffScans(baseline, current);
  const r = renderDriftAlert({ targetUrl: 'https://example.com', diff });
  assert.equal(r.plainText.includes('**'), false);
  assert.equal(r.plainText.includes('`'), false);
});
