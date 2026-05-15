'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isHighSignal,
  clusterKeyFor,
  clusterByRule,
  rankClusters,
  clusterAndRankUrlFindings,
  HIGH_SIGNAL_PREFIXES,
} = require('../website/app/lib/url-finding-clusterer.js');

test('isHighSignal — TLS rules are high signal', () => {
  assert.equal(isHighSignal('tls-security:expired-cert'), true);
  assert.equal(isHighSignal('tls-no-https'), true);
});

test('isHighSignal — xmlrpc pingback is high signal', () => {
  assert.equal(isHighSignal('wp-xmlrpc:pingback-available'), true);
});

test('isHighSignal — exposed files high signal', () => {
  assert.equal(isHighSignal('wp-exposed-files:found:wp-config.php.bak'), true);
});

test('isHighSignal — admin discovery high signal', () => {
  assert.equal(isHighSignal('admin-discovery:wp-admin-reachable'), true);
});

test('isHighSignal — open redirect high signal', () => {
  assert.equal(isHighSignal('open-redirect:?next-param'), true);
});

test('isHighSignal — secret leak high signal', () => {
  assert.equal(isHighSignal('secret-leak:aws-key-in-html'), true);
});

test('isHighSignal — generic headers are NOT high signal', () => {
  assert.equal(isHighSignal('web-headers:missing-csp'), false);
  assert.equal(isHighSignal('cookie-security:missing-secure'), false);
});

test('isHighSignal — non-string returns false', () => {
  assert.equal(isHighSignal(null), false);
  assert.equal(isHighSignal(undefined), false);
  assert.equal(isHighSignal(42), false);
});

test('HIGH_SIGNAL_PREFIXES is non-empty', () => {
  assert.ok(Array.isArray(HIGH_SIGNAL_PREFIXES));
  assert.ok(HIGH_SIGNAL_PREFIXES.length >= 5);
});

test('clusterKeyFor — prefers ruleKey when available', () => {
  const f = { ruleKey: 'web-headers:missing-csp', module: 'webHeaders', title: 'Missing CSP' };
  assert.equal(clusterKeyFor(f), 'web-headers:missing-csp');
});

test('clusterKeyFor — falls back to module:title when no ruleKey', () => {
  const f = { module: 'webHeaders', title: 'Missing CSP header' };
  assert.equal(clusterKeyFor(f), 'webHeaders:Missing CSP header');
});

test('clusterKeyFor — falls back to module alone when no title', () => {
  const f = { module: 'webHeaders' };
  assert.equal(clusterKeyFor(f), 'webHeaders');
});

test('clusterKeyFor — returns "unknown" for empty input', () => {
  assert.equal(clusterKeyFor(null), 'unknown');
  assert.equal(clusterKeyFor(undefined), 'unknown');
});

test('clusterByRule — groups identical rules into one cluster', () => {
  const findings = [
    { ruleKey: 'web-headers:missing-csp', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'web-headers:missing-csp', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'web-headers:missing-csp', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'web-headers:missing-hsts', severity: 'warning', title: 't', body: 'b', module: 'm' },
  ];
  const clusters = clusterByRule(findings);
  assert.equal(clusters.length, 2);
  const csp = clusters.find((c) => c.ruleKey === 'web-headers:missing-csp');
  assert.ok(csp);
  assert.equal(csp.count, 3);
});

test('clusterByRule — promotes severity if a more-severe instance arrives later', () => {
  const findings = [
    { ruleKey: 'rule-x', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-x', severity: 'error', title: 't', body: 'b', module: 'm' },
  ];
  const clusters = clusterByRule(findings);
  assert.equal(clusters[0].severity, 'error');
});

test('clusterByRule — flags high-signal rules', () => {
  const findings = [
    { ruleKey: 'tls-security:expired-cert', severity: 'error', title: 't', body: 'b', module: 'tls' },
    { ruleKey: 'web-headers:missing-csp', severity: 'warning', title: 't', body: 'b', module: 'wh' },
  ];
  const clusters = clusterByRule(findings);
  const tls = clusters.find((c) => c.ruleKey === 'tls-security:expired-cert');
  const wh = clusters.find((c) => c.ruleKey === 'web-headers:missing-csp');
  assert.equal(tls.isHighSignal, true);
  assert.equal(wh.isHighSignal, false);
});

test('clusterByRule — non-array input returns []', () => {
  assert.deepEqual(clusterByRule(null), []);
  assert.deepEqual(clusterByRule(undefined), []);
  assert.deepEqual(clusterByRule('not-array'), []);
});

test('clusterByRule — skips invalid entries silently', () => {
  const findings = [null, undefined, 'string', { ruleKey: 'ok', severity: 'error', title: 't', body: 'b', module: 'm' }];
  const clusters = clusterByRule(findings);
  assert.equal(clusters.length, 1);
});

test('rankClusters — high signal beats non-high signal of same severity', () => {
  const findings = [
    { ruleKey: 'web-headers:missing-csp', severity: 'error', title: 't', body: 'b', module: 'wh' },
    { ruleKey: 'tls-security:expired-cert', severity: 'error', title: 't', body: 'b', module: 'tls' },
  ];
  const clusters = rankClusters(clusterByRule(findings));
  assert.equal(clusters[0].ruleKey, 'tls-security:expired-cert');
});

test('rankClusters — error severity beats warning', () => {
  const findings = [
    { ruleKey: 'rule-w', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-w', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-w', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-e', severity: 'error', title: 't', body: 'b', module: 'm' },
  ];
  const clusters = rankClusters(clusterByRule(findings));
  assert.equal(clusters[0].ruleKey, 'rule-e');
});

test('rankClusters — same severity, higher count wins', () => {
  const findings = [
    { ruleKey: 'rule-small', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-big', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-big', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'rule-big', severity: 'warning', title: 't', body: 'b', module: 'm' },
  ];
  const clusters = rankClusters(clusterByRule(findings));
  assert.equal(clusters[0].ruleKey, 'rule-big');
});

test('rankClusters — deterministic tie-break by ruleKey', () => {
  const findings = [
    { ruleKey: 'zzz', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'aaa', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'mmm', severity: 'warning', title: 't', body: 'b', module: 'm' },
  ];
  const clusters = rankClusters(clusterByRule(findings));
  assert.deepEqual(clusters.map((c) => c.ruleKey), ['aaa', 'mmm', 'zzz']);
});

test('clusterAndRankUrlFindings — drops info by default', () => {
  const findings = [
    { ruleKey: 'r1', severity: 'error', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'r2', severity: 'warning', title: 't', body: 'b', module: 'm' },
    { ruleKey: 'r3', severity: 'info', title: 't', body: 'b', module: 'm' },
  ];
  const result = clusterAndRankUrlFindings(findings);
  assert.equal(result.clusters.length, 2);
  assert.equal(result.droppedInfo, 1);
  assert.equal(result.totalIn, 3);
});

test('clusterAndRankUrlFindings — includeInfo: true keeps info', () => {
  const findings = [
    { ruleKey: 'r1', severity: 'info', title: 't', body: 'b', module: 'm' },
  ];
  const result = clusterAndRankUrlFindings(findings, { includeInfo: true });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.droppedInfo, 0);
});

test('clusterAndRankUrlFindings — realistic noisy scan: 1000 findings → handful of clusters', () => {
  // 200 instances of missing CSP across pages, 200 instances of broken link,
  // 1 critical TLS issue, 600 info-level scan noise
  const findings = [];
  for (let i = 0; i < 200; i++) findings.push({ ruleKey: 'web-headers:missing-csp', severity: 'warning', title: 'Missing CSP', body: 'b', module: 'webHeaders' });
  for (let i = 0; i < 200; i++) findings.push({ ruleKey: 'links:broken', severity: 'warning', title: 'Broken link', body: 'b', module: 'links' });
  findings.push({ ruleKey: 'tls-security:expired-cert', severity: 'error', title: 'Expired cert', body: 'b', module: 'tls' });
  for (let i = 0; i < 600; i++) findings.push({ ruleKey: `summary-${i}`, severity: 'info', title: 'scanned', body: '', module: 'summary' });

  const result = clusterAndRankUrlFindings(findings);
  // 3 unique non-info rules → 3 clusters
  assert.equal(result.clusters.length, 3);
  // TLS is high-signal → first
  assert.equal(result.clusters[0].ruleKey, 'tls-security:expired-cert');
  assert.equal(result.clusters[0].isHighSignal, true);
  // 600 info findings dropped
  assert.equal(result.droppedInfo, 600);
  // Total non-info instances = 401
  assert.equal(result.totalInstances, 401);
});

test('clusterAndRankUrlFindings — empty / null safe', () => {
  const r1 = clusterAndRankUrlFindings([]);
  assert.equal(r1.clusters.length, 0);
  const r2 = clusterAndRankUrlFindings(null);
  assert.equal(r2.clusters.length, 0);
});
