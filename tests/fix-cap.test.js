'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIER_CAPS,
  DEFAULT_CAP,
  getCapForTier,
  applyFixCap,
  clustersToIssues,
  renderAdvisorySection,
} = require('../website/app/lib/fix-cap.js');

function makeCluster(file, count = 1, topSeverity = 'error') {
  const issues = [];
  for (let i = 0; i < count; i++) {
    issues.push({ file, issue: `error: finding ${i}`, module: 'm1' });
  }
  return {
    file,
    issues,
    count,
    modules: ['m1'],
    severityCounts: { error: topSeverity === 'error' ? count : 0, warning: topSeverity === 'warning' ? count : 0, info: 0 },
    topSeverity,
    isRootCause: false,
  };
}

test('TIER_CAPS — frozen + has all tiers', () => {
  assert.equal(Object.isFrozen(TIER_CAPS), true);
  assert.equal(TIER_CAPS.quick, 5);
  assert.equal(TIER_CAPS.full, 20);
  assert.equal(TIER_CAPS.scan_fix, 50);
  assert.equal(TIER_CAPS.nuclear, 100);
});

test('TIER_CAPS — scan_fix and scanFix are both supported', () => {
  assert.equal(TIER_CAPS.scan_fix, TIER_CAPS.scanFix);
});

test('getCapForTier — known tiers return their caps', () => {
  assert.equal(getCapForTier('quick'), 5);
  assert.equal(getCapForTier('full'), 20);
  assert.equal(getCapForTier('scan_fix'), 50);
  assert.equal(getCapForTier('nuclear'), 100);
});

test('getCapForTier — case-insensitive', () => {
  assert.equal(getCapForTier('QUICK'), 5);
  assert.equal(getCapForTier(' Full '), 20);
});

test('getCapForTier — unknown tier returns DEFAULT_CAP', () => {
  assert.equal(getCapForTier('mystery'), DEFAULT_CAP);
  assert.equal(getCapForTier(''), DEFAULT_CAP);
  assert.equal(getCapForTier(null), DEFAULT_CAP);
  assert.equal(getCapForTier(undefined), DEFAULT_CAP);
  assert.equal(getCapForTier(42), DEFAULT_CAP);
});

test('applyFixCap — Quick tier caps at 5', () => {
  const clusters = Array.from({ length: 10 }, (_, i) => makeCluster(`file-${i}.js`));
  const result = applyFixCap(clusters, 'quick');
  assert.equal(result.toFix.length, 5);
  assert.equal(result.advisory.length, 5);
  assert.equal(result.cap, 5);
  assert.equal(result.wouldHaveFixed, 5);
});

test('applyFixCap — Full tier caps at 20', () => {
  const clusters = Array.from({ length: 30 }, (_, i) => makeCluster(`file-${i}.js`));
  const result = applyFixCap(clusters, 'full');
  assert.equal(result.toFix.length, 20);
  assert.equal(result.advisory.length, 10);
});

test('applyFixCap — Nuclear tier caps at 100', () => {
  const clusters = Array.from({ length: 150 }, (_, i) => makeCluster(`file-${i}.js`));
  const result = applyFixCap(clusters, 'nuclear');
  assert.equal(result.toFix.length, 100);
  assert.equal(result.advisory.length, 50);
});

test('applyFixCap — below cap, advisory is empty', () => {
  const clusters = [makeCluster('a.js'), makeCluster('b.js')];
  const result = applyFixCap(clusters, 'full');
  assert.equal(result.toFix.length, 2);
  assert.equal(result.advisory.length, 0);
  assert.equal(result.wouldHaveFixed, 0);
});

test('applyFixCap — empty / bad input is safe', () => {
  const r1 = applyFixCap([], 'full');
  assert.equal(r1.toFix.length, 0);
  assert.equal(r1.advisory.length, 0);

  const r2 = applyFixCap(null, 'full');
  assert.equal(r2.toFix.length, 0);

  const r3 = applyFixCap(undefined, 'full');
  assert.equal(r3.toFix.length, 0);
});

test('applyFixCap — advisoryIssueCount sums correctly', () => {
  const clusters = [
    makeCluster('a.js', 3),
    makeCluster('b.js', 5),
    makeCluster('c.js', 100), // big one beyond the quick cap
    makeCluster('d.js', 7),
    makeCluster('e.js', 2),
    makeCluster('f.js', 50), // beyond quick cap (cap=5)
    makeCluster('g.js', 80), // beyond quick cap
  ];
  const result = applyFixCap(clusters, 'quick');
  assert.equal(result.toFix.length, 5);
  assert.equal(result.advisory.length, 2);
  assert.equal(result.advisoryIssueCount, 50 + 80);
});

test('applyFixCap — preserves cluster order (ranked input → ranked output)', () => {
  const clusters = [
    makeCluster('tsconfig.json', 200),
    makeCluster('eslintrc.json', 100),
    makeCluster('src/a.js', 5),
  ];
  const result = applyFixCap(clusters, 'full');
  assert.equal(result.toFix[0].file, 'tsconfig.json');
  assert.equal(result.toFix[1].file, 'eslintrc.json');
  assert.equal(result.toFix[2].file, 'src/a.js');
});

test('clustersToIssues — flattens back to IssueInput[]', () => {
  const clusters = [makeCluster('a.js', 3), makeCluster('b.js', 2)];
  const issues = clustersToIssues(clusters);
  assert.equal(issues.length, 5);
  assert.ok(issues.every((i) => i && typeof i.file === 'string'));
});

test('clustersToIssues — bad input safe', () => {
  assert.deepEqual(clustersToIssues(null), []);
  assert.deepEqual(clustersToIssues(undefined), []);
  assert.deepEqual(clustersToIssues([null, { issues: null }, undefined]), []);
});

test('renderAdvisorySection — empty advisory returns empty string', () => {
  const result = applyFixCap([makeCluster('a.js')], 'full');
  assert.equal(renderAdvisorySection(result), '');
});

test('renderAdvisorySection — non-empty includes file table', () => {
  const clusters = Array.from({ length: 8 }, (_, i) => makeCluster(`file-${i}.js`, 3));
  const capResult = applyFixCap(clusters, 'quick');
  const md = renderAdvisorySection(capResult);
  assert.ok(md.includes('## Advisory'));
  assert.ok(md.includes('| File |'));
  assert.ok(md.includes('file-5.js')); // 6th file = first in advisory
  assert.ok(md.includes('quick'));
  assert.ok(md.includes('5 file-fixes')); // mentions cap
});

test('renderAdvisorySection — caps the table at 50 rows', () => {
  const clusters = Array.from({ length: 60 }, (_, i) => makeCluster(`file-${i}.js`));
  const capResult = applyFixCap(clusters, 'quick');
  const md = renderAdvisorySection(capResult);
  // 55 advisory clusters; only 50 should be tabulated
  const matchedRows = (md.match(/^\| `file-/gm) || []).length;
  assert.equal(matchedRows, 50);
  assert.ok(md.includes('5 more files not shown')); // 55 - 50 = 5 hidden
});

test('renderAdvisorySection — bad input safe', () => {
  assert.equal(renderAdvisorySection(null), '');
  assert.equal(renderAdvisorySection({ advisory: null }), '');
  assert.equal(renderAdvisorySection({ advisory: [] }), '');
});
