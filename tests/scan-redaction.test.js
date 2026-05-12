'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');

const {
  AI_COST_MODULES,
  computeShadowTier,
  redactScanResult,
  summariseShadowResult,
} = require('../lib/scan-redaction');

// ─── computeShadowTier ────────────────────────────────────────────────────────

test('computeShadowTier("quick") returns "quick_shadow"', () => {
  assert.equal(computeShadowTier('quick'), 'quick_shadow');
});

test('computeShadowTier("full") returns "full"', () => {
  assert.equal(computeShadowTier('full'), 'full');
});

test('computeShadowTier("nuclear") returns "nuclear"', () => {
  assert.equal(computeShadowTier('nuclear'), 'nuclear');
});

test('computeShadowTier("scan_fix") returns "scan_fix"', () => {
  assert.equal(computeShadowTier('scan_fix'), 'scan_fix');
});

test('computeShadowTier("garbage") returns "quick" (defensive fallback)', () => {
  assert.equal(computeShadowTier('garbage'), 'quick');
});

// ─── redactScanResult — paid module kept verbatim ────────────────────────────

test('redactScanResult keeps details verbatim for modules inside tierModules', () => {
  const result = {
    modules: [
      { name: 'syntax', status: 'passed', checks: 10, issues: 0, details: ['ok'] },
    ],
    totalIssues: 0,
    duration: 123,
  };
  const redacted = redactScanResult({
    result,
    paidTier: 'quick',
    tierModules: ['syntax'],
  });

  const mod = redacted.modules.find((m) => m.name === 'syntax');
  assert.ok(mod, 'syntax module present');
  assert.deepEqual(mod.details, ['ok'], 'details kept verbatim');
  assert.equal(mod.redacted, undefined, 'redacted flag absent for paid module');
  assert.equal(mod.upgradeHint, undefined, 'no upgradeHint for paid module');
});

// ─── redactScanResult — unpaid module is redacted ────────────────────────────

test('redactScanResult redacts details for modules NOT in tierModules', () => {
  const result = {
    modules: [
      { name: 'security', status: 'failed', checks: 5, issues: 3, details: ['secret found', 'eval() call'] },
    ],
    totalIssues: 3,
    duration: 50,
  };
  const redacted = redactScanResult({
    result,
    paidTier: 'quick',
    tierModules: ['syntax', 'lint'], // security NOT in paid tier
  });

  const mod = redacted.modules.find((m) => m.name === 'security');
  assert.ok(mod, 'security module present in output');
  assert.deepEqual(mod.details, [], 'details replaced with empty array');
  assert.equal(mod.redacted, true, 'redacted flag set to true');
  assert.ok(typeof mod.upgradeHint === 'string' && mod.upgradeHint.length > 0, 'upgradeHint is a non-empty string');
  // Counts and status are preserved so customer can see there ARE issues
  assert.equal(mod.issues, 3, 'issue count preserved');
  assert.equal(mod.status, 'failed', 'status preserved');
});

// ─── redactScanResult — shadowSummary counts are correct ─────────────────────

test('redactScanResult adds shadowSummary with correct counts', () => {
  const result = {
    modules: [
      { name: 'syntax',   status: 'passed', checks: 10, issues: 0, details: [] },
      { name: 'lint',     status: 'failed', checks: 8,  issues: 2, details: ['a', 'b'] },
      { name: 'security', status: 'failed', checks: 5,  issues: 7, details: ['c'] },
      { name: 'aiReview', status: 'skipped', checks: 0, issues: 0, details: [] },
    ],
    totalIssues: 9,
    duration: 200,
  };

  const redacted = redactScanResult({
    result,
    paidTier: 'quick',
    tierModules: ['syntax', 'lint'],
  });

  const s = redacted.shadowSummary;
  assert.ok(s, 'shadowSummary present');
  assert.equal(s.paidModules, 2,  'paidModules = 2 (syntax + lint)');
  assert.equal(s.paidIssues,  2,  'paidIssues  = 2 (from lint)');
  assert.equal(s.hiddenModules, 2, 'hiddenModules = 2 (security + aiReview)');
  assert.equal(s.hiddenIssues,  7, 'hiddenIssues = 7 (from security; aiReview=0)');
  assert.equal(s.paidTier, 'quick', 'paidTier recorded');
  assert.ok(typeof s.upgradeHint === 'string', 'upgradeHint is a string');
});

// ─── redactScanResult — does NOT mutate the input ────────────────────────────

test('redactScanResult does not mutate the original result object', () => {
  const originalDetails = ['eval() call'];
  const result = {
    modules: [
      { name: 'security', status: 'failed', checks: 1, issues: 1, details: originalDetails },
    ],
    totalIssues: 1,
    duration: 30,
  };

  redactScanResult({ result, paidTier: 'quick', tierModules: ['syntax'] });

  // Original details array must be untouched.
  assert.deepEqual(result.modules[0].details, ['eval() call'], 'original details unchanged');
  assert.equal(result.modules[0].redacted, undefined, 'original module has no redacted flag');
  assert.equal(result.shadowSummary, undefined, 'original result has no shadowSummary');
});

// ─── summariseShadowResult ────────────────────────────────────────────────────

test('summariseShadowResult returns expected string shape', () => {
  const summary = {
    hiddenIssues: 31,
    hiddenModules: 18,
    paidModules: 4,
    paidIssues: 12,
    paidTier: 'quick',
  };
  const line = summariseShadowResult(summary);
  assert.equal(
    line,
    'shadow: 31 issues hidden across 18 modules (paid quick=12 issues across 4 modules)',
  );
});

// ─── Edge: empty modules array ────────────────────────────────────────────────

test('redactScanResult with empty modules array produces empty summary with no errors', () => {
  const result = { modules: [], totalIssues: 0, duration: 0 };
  const redacted = redactScanResult({
    result,
    paidTier: 'quick',
    tierModules: ['syntax', 'lint'],
  });

  assert.deepEqual(redacted.modules, [], 'modules still empty');
  const s = redacted.shadowSummary;
  assert.equal(s.hiddenIssues,  0, 'hiddenIssues = 0');
  assert.equal(s.hiddenModules, 0, 'hiddenModules = 0');
  assert.equal(s.paidModules,   0, 'paidModules = 0');
  assert.equal(s.paidIssues,    0, 'paidIssues = 0');
});

test('summariseShadowResult with all-zero summary does not throw', () => {
  const line = summariseShadowResult({
    hiddenIssues: 0,
    hiddenModules: 0,
    paidModules: 0,
    paidIssues: 0,
    paidTier: 'quick',
  });
  assert.equal(
    line,
    'shadow: 0 issues hidden across 0 modules (paid quick=0 issues across 0 modules)',
  );
});

// ─── AI_COST_MODULES sanity ───────────────────────────────────────────────────

test('AI_COST_MODULES is a Set containing aiReview', () => {
  assert.ok(AI_COST_MODULES instanceof Set, 'AI_COST_MODULES is a Set');
  assert.ok(AI_COST_MODULES.has('aiReview'), 'aiReview is marked as AI-cost module');
});
