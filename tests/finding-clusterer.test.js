'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySeverity,
  isRootCauseFile,
  partitionBySeverity,
  clusterByFile,
  rankClusters,
  clusterAndRank,
} = require('../website/app/lib/finding-clusterer.js');

test('classifySeverity — error prefix', () => {
  assert.equal(classifySeverity('error: hardcoded secret'), 'error');
  assert.equal(classifySeverity('critical: SQL injection'), 'error');
});

test('classifySeverity — warning prefix', () => {
  assert.equal(classifySeverity('warning: unused import'), 'warning');
  assert.equal(classifySeverity('medium: missing CSP header'), 'warning');
});

test('classifySeverity — info prefix', () => {
  assert.equal(classifySeverity('info: scanned 42 files'), 'info');
  assert.equal(classifySeverity('summary: 0 errors'), 'info');
});

test('classifySeverity — heuristic fallback to error', () => {
  // No prefix but body contains hardcoded — should classify error
  assert.equal(classifySeverity('hardcoded API key detected'), 'error');
});

test('classifySeverity — defaults to warning when nothing matches', () => {
  assert.equal(classifySeverity('something nondescript here'), 'warning');
});

test('classifySeverity — non-string returns warning', () => {
  assert.equal(classifySeverity(null), 'warning');
  assert.equal(classifySeverity(undefined), 'warning');
  assert.equal(classifySeverity(42), 'warning');
});

test('isRootCauseFile — tsconfig variants', () => {
  assert.equal(isRootCauseFile('tsconfig.json'), true);
  assert.equal(isRootCauseFile('website/tsconfig.json'), true);
  assert.equal(isRootCauseFile('tsconfig.build.json'), true);
});

test('isRootCauseFile — eslintrc variants', () => {
  assert.equal(isRootCauseFile('.eslintrc'), true);
  assert.equal(isRootCauseFile('.eslintrc.json'), true);
  assert.equal(isRootCauseFile('eslint.config.mjs'), true);
});

test('isRootCauseFile — env files', () => {
  assert.equal(isRootCauseFile('.env'), true);
  assert.equal(isRootCauseFile('.env.production'), true);
  assert.equal(isRootCauseFile('.env.example'), true);
});

test('isRootCauseFile — GitHub workflows', () => {
  assert.equal(isRootCauseFile('.github/workflows/ci.yml'), true);
  assert.equal(isRootCauseFile('.github/workflows/deploy.yaml'), true);
});

test('isRootCauseFile — regular source files are not root-cause', () => {
  assert.equal(isRootCauseFile('src/index.js'), false);
  assert.equal(isRootCauseFile('app/components/Hero.tsx'), false);
  assert.equal(isRootCauseFile('README.md'), false);
});

test('isRootCauseFile — non-string input', () => {
  assert.equal(isRootCauseFile(null), false);
  assert.equal(isRootCauseFile(undefined), false);
  assert.equal(isRootCauseFile(42), false);
});

test('partitionBySeverity — splits by severity', () => {
  const issues = [
    { file: 'a.js', issue: 'error: foo', module: 'x' },
    { file: 'b.js', issue: 'warning: bar', module: 'y' },
    { file: 'c.js', issue: 'info: scanned 10 files', module: 'z' },
    { file: 'd.js', issue: 'critical: SQL injection', module: 'x' },
  ];
  const result = partitionBySeverity(issues);
  assert.equal(result.errors.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.info.length, 1);
});

test('partitionBySeverity — handles empty + bad input', () => {
  const result = partitionBySeverity([]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.info.length, 0);

  const result2 = partitionBySeverity(null);
  assert.equal(result2.errors.length, 0);

  const result3 = partitionBySeverity([null, undefined, 'string', { file: 'x.js', issue: 'error: foo', module: 'm' }]);
  assert.equal(result3.errors.length, 1);
});

test('clusterByFile — groups issues by file', () => {
  const issues = [
    { file: 'a.js', issue: 'error: foo', module: 'm1' },
    { file: 'a.js', issue: 'error: bar', module: 'm2' },
    { file: 'b.js', issue: 'warning: baz', module: 'm1' },
  ];
  const clusters = clusterByFile(issues);
  assert.equal(clusters.length, 2);
  const a = clusters.find((c) => c.file === 'a.js');
  assert.ok(a);
  assert.equal(a.count, 2);
  assert.equal(a.severityCounts.error, 2);
  assert.deepEqual(a.modules, ['m1', 'm2']);
});

test('clusterByFile — drops issues without file', () => {
  const issues = [
    { file: 'a.js', issue: 'error: foo', module: 'm1' },
    { issue: 'error: no file', module: 'm2' },
    { file: '', issue: 'error: empty file', module: 'm3' },
    null,
    undefined,
  ];
  const clusters = clusterByFile(issues);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].file, 'a.js');
});

test('clusterByFile — flags root-cause files', () => {
  const issues = [
    { file: 'tsconfig.json', issue: 'error: strict false', module: 'tsStrict' },
    { file: 'src/index.js', issue: 'error: any', module: 'tsStrict' },
  ];
  const clusters = clusterByFile(issues);
  const tsconfig = clusters.find((c) => c.file === 'tsconfig.json');
  const src = clusters.find((c) => c.file === 'src/index.js');
  assert.equal(tsconfig.isRootCause, true);
  assert.equal(src.isRootCause, false);
});

test('clusterByFile — topSeverity reflects highest', () => {
  const issues = [
    { file: 'a.js', issue: 'info: scanned 10', module: 'm1' },
    { file: 'a.js', issue: 'warning: missing CSP', module: 'm1' },
    { file: 'a.js', issue: 'error: SQL injection', module: 'm1' },
  ];
  const clusters = clusterByFile(issues);
  assert.equal(clusters[0].topSeverity, 'error');
});

test('rankClusters — root-cause files come first', () => {
  const issues = [
    { file: 'src/index.js', issue: 'error: foo', module: 'm1' },
    { file: 'src/index.js', issue: 'error: bar', module: 'm1' },
    { file: 'src/index.js', issue: 'error: baz', module: 'm1' },
    { file: 'tsconfig.json', issue: 'error: strict false', module: 'tsStrict' },
  ];
  const clusters = rankClusters(clusterByFile(issues));
  assert.equal(clusters[0].file, 'tsconfig.json');
  assert.equal(clusters[1].file, 'src/index.js');
});

test('rankClusters — among non-root-cause, error beats warning', () => {
  const issues = [
    { file: 'a.js', issue: 'warning: w1', module: 'm1' },
    { file: 'a.js', issue: 'warning: w2', module: 'm1' },
    { file: 'a.js', issue: 'warning: w3', module: 'm1' },
    { file: 'b.js', issue: 'error: e1', module: 'm1' },
  ];
  const clusters = rankClusters(clusterByFile(issues));
  assert.equal(clusters[0].file, 'b.js');
  assert.equal(clusters[1].file, 'a.js');
});

test('rankClusters — same severity, higher count wins', () => {
  const issues = [
    { file: 'a.js', issue: 'error: e1', module: 'm1' },
    { file: 'b.js', issue: 'error: e1', module: 'm1' },
    { file: 'b.js', issue: 'error: e2', module: 'm1' },
    { file: 'b.js', issue: 'error: e3', module: 'm1' },
  ];
  const clusters = rankClusters(clusterByFile(issues));
  assert.equal(clusters[0].file, 'b.js');
  assert.equal(clusters[0].count, 3);
});

test('rankClusters — deterministic tie-break by file name', () => {
  const issues = [
    { file: 'z.js', issue: 'error: e', module: 'm1' },
    { file: 'a.js', issue: 'error: e', module: 'm1' },
    { file: 'm.js', issue: 'error: e', module: 'm1' },
  ];
  const clusters = rankClusters(clusterByFile(issues));
  assert.deepEqual(clusters.map((c) => c.file), ['a.js', 'm.js', 'z.js']);
});

test('rankClusters — non-array input returns empty', () => {
  assert.deepEqual(rankClusters(null), []);
  assert.deepEqual(rankClusters(undefined), []);
  assert.deepEqual(rankClusters('not-an-array'), []);
});

test('clusterAndRank — defaults to errors-only', () => {
  const issues = [
    { file: 'a.js', issue: 'error: e', module: 'm1' },
    { file: 'b.js', issue: 'warning: w', module: 'm1' },
    { file: 'c.js', issue: 'info: i', module: 'm1' },
  ];
  const result = clusterAndRank(issues);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].file, 'a.js');
  assert.equal(result.advisory.warnings.length, 1);
  assert.equal(result.advisory.info.length, 1);
  assert.equal(result.totalIssuesIn, 3);
  assert.equal(result.totalIssuesClustered, 1);
});

test('clusterAndRank — includeWarnings opt promotes them to fixable', () => {
  const issues = [
    { file: 'a.js', issue: 'error: e', module: 'm1' },
    { file: 'b.js', issue: 'warning: w', module: 'm1' },
    { file: 'c.js', issue: 'info: i', module: 'm1' },
  ];
  const result = clusterAndRank(issues, { includeWarnings: true });
  assert.equal(result.clusters.length, 2);
  assert.equal(result.advisory.warnings.length, 0);
  assert.equal(result.advisory.info.length, 1);
});

test('clusterAndRank — empty / bad input is safe', () => {
  const r1 = clusterAndRank([]);
  assert.equal(r1.clusters.length, 0);
  assert.equal(r1.totalIssuesIn, 0);

  const r2 = clusterAndRank(null);
  assert.equal(r2.clusters.length, 0);
});

test('clusterAndRank — realistic 1000-finding scan collapses to handful of clusters', () => {
  // Simulate 200 implicit-any findings across 50 files + 1 tsconfig finding
  const issues = [];
  for (let i = 0; i < 200; i++) {
    issues.push({
      file: `src/feature-${i % 50}/index.ts`,
      issue: 'error: implicit any in parameter',
      module: 'tsStrict',
    });
  }
  issues.push({
    file: 'tsconfig.json',
    issue: 'error: strict mode is disabled — root cause',
    module: 'tsStrict',
  });
  const result = clusterAndRank(issues);
  // 50 source files + 1 tsconfig = 51 clusters, not 201 individual fixes
  assert.equal(result.clusters.length, 51);
  // tsconfig MUST come first (root cause)
  assert.equal(result.clusters[0].file, 'tsconfig.json');
  assert.equal(result.clusters[0].isRootCause, true);
});
