// ============================================================================
// CONFIDENCE-AWARE REPORTING TEST — Phase 5.2.3 of THE 110% MANDATE
// ============================================================================
// Pure-function coverage for the per-customer severity adjuster that
// downgrades / suppresses noisy module findings based on the brain's
// per-(module, pattern) confidence scores.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  SEVERITY_TRANSFORM,
  classifySeverity,
  reprefixSeverity,
  applyConfidenceToModule,
  applyConfidenceToScan,
  buildResolveAction,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'confidence-aware-report.js'));

// ---------- shape ----------

test('SEVERITY_TRANSFORM defines all four actions and three severities', () => {
  for (const action of ['trust', 'downgrade', 'double-down']) {
    assert.ok(SEVERITY_TRANSFORM[action], `missing ${action}`);
    for (const sev of ['error', 'warning', 'info']) {
      assert.ok(SEVERITY_TRANSFORM[action][sev], `missing ${action}.${sev}`);
    }
  }
  // suppress is handled separately (drop the finding) — no entry in transform
});

// ---------- classifySeverity ----------

describe('classifySeverity', () => {
  it('respects explicit prefixes', () => {
    assert.strictEqual(classifySeverity('error: oops'), 'error');
    assert.strictEqual(classifySeverity('warning: meh'), 'warning');
    assert.strictEqual(classifySeverity('info: heads-up'), 'info');
  });

  it('falls back to keyword heuristic', () => {
    assert.strictEqual(classifySeverity('hardcoded API key found'), 'error');
    assert.strictEqual(classifySeverity('package is deprecated'), 'warning');
    assert.strictEqual(classifySeverity('summary: scanned 50 files'), 'info');
  });

  it('defaults to warning when nothing matches', () => {
    assert.strictEqual(classifySeverity('something neutral'), 'warning');
  });
});

// ---------- reprefixSeverity ----------

describe('reprefixSeverity', () => {
  it('strips existing prefix and applies the new one', () => {
    assert.strictEqual(reprefixSeverity('error: bad code', 'warning'), 'warning: bad code');
    assert.strictEqual(reprefixSeverity('warning: meh', 'info'), 'info: meh');
  });

  it('handles raws with no existing prefix', () => {
    assert.strictEqual(reprefixSeverity('uses var declaration', 'info'), 'info: uses var declaration');
  });

  it('is idempotent — re-prefixing same severity produces same output', () => {
    const first = reprefixSeverity('error: oops', 'warning');
    const second = reprefixSeverity(first, 'warning');
    assert.strictEqual(first, second);
  });
});

// ---------- applyConfidenceToModule ----------

describe('applyConfidenceToModule', () => {
  it('"trust" action passes the module through unchanged', () => {
    const module = {
      name: 'lint',
      status: 'failed',
      details: ['error: src/a.ts:1 — no-var'],
      issues: 1,
    };
    const out = applyConfidenceToModule(module, () => 'trust');
    assert.strictEqual(out.module, module);
    assert.deepStrictEqual(out.suppressed, []);
    assert.deepStrictEqual(out.downgraded, []);
  });

  it('"suppress" action drops every finding', () => {
    const module = {
      name: 'lint',
      status: 'failed',
      details: ['error: foo', 'warning: bar', 'info: baz'],
      issues: 3,
    };
    const out = applyConfidenceToModule(module, () => 'suppress');
    assert.strictEqual(out.module.issues, 0);
    assert.deepStrictEqual(out.module.details, []);
    assert.strictEqual(out.suppressed.length, 3);
  });

  it('"downgrade" action shifts error→warning, warning→info, info→info', () => {
    const module = {
      name: 'lint',
      status: 'failed',
      details: [
        'error: hardcoded API key in src/a.ts',
        'warning: package deprecated',
        'info: summary',
      ],
      issues: 3,
    };
    const out = applyConfidenceToModule(module, () => 'downgrade');
    // Each detail re-prefixed with new severity
    assert.match(out.module.details[0], /^warning: /);
    assert.match(out.module.details[1], /^info: /);
    assert.match(out.module.details[2], /^info: /);
    assert.strictEqual(out.downgraded.length, 2); // error→warning AND warning→info
  });

  it('"double-down" action collapses everything to info', () => {
    const module = {
      name: 'secrets',
      details: ['error: hardcoded token', 'warning: env drift'],
      issues: 2,
    };
    const out = applyConfidenceToModule(module, () => 'double-down');
    for (const d of out.module.details) {
      assert.match(d, /^info: /);
    }
    assert.strictEqual(out.downgraded.length, 2);
  });

  it('handles missing or empty modules gracefully', () => {
    const empty = applyConfidenceToModule({ name: 'lint', details: [] }, () => 'suppress');
    assert.deepStrictEqual(empty.suppressed, []);

    const noDetails = applyConfidenceToModule({ name: 'lint' }, () => 'suppress');
    assert.deepStrictEqual(noDetails.suppressed, []);

    const bad = applyConfidenceToModule(null, () => 'suppress');
    assert.deepStrictEqual(bad.suppressed, []);
  });

  it('handles missing resolveAction by passing through unchanged', () => {
    const module = { name: 'lint', details: ['error: x'], issues: 1 };
    const out = applyConfidenceToModule(module, undefined);
    assert.strictEqual(out.module, module);
  });
});

// ---------- applyConfidenceToScan ----------

describe('applyConfidenceToScan', () => {
  const sampleScan = {
    modules: [
      { name: 'lint', status: 'failed', details: ['error: foo', 'warning: bar'], issues: 2 },
      { name: 'secrets', status: 'failed', details: ['error: hardcoded'], issues: 1 },
      { name: 'syntax', status: 'passed', details: [], issues: 0 },
    ],
    totalIssues: 3,
  };

  it('downgrades only the modules the resolver flags', () => {
    const resolveAction = (mod) => mod === 'lint' ? 'downgrade' : 'trust';
    const out = applyConfidenceToScan(sampleScan, resolveAction);
    // lint: error → warning, warning → info  (2 downgrades)
    assert.match(out.scanResult.modules[0].details[0], /^warning: /);
    assert.match(out.scanResult.modules[0].details[1], /^info: /);
    // secrets: untouched
    assert.match(out.scanResult.modules[1].details[0], /^error: /);
    assert.strictEqual(out.adjustments.downgradedCount, 2);
  });

  it('suppresses noisy modules entirely', () => {
    const resolveAction = (mod) => mod === 'lint' ? 'suppress' : 'trust';
    const out = applyConfidenceToScan(sampleScan, resolveAction);
    // lint findings dropped, but module entry remains (with empty details)
    assert.strictEqual(out.scanResult.modules[0].issues, 0);
    assert.strictEqual(out.scanResult.modules[0].details.length, 0);
    assert.strictEqual(out.adjustments.suppressedCount, 2);
  });

  it('recomputes totalIssues from adjusted modules', () => {
    // Suppress lint entirely; secrets stays. Original total = 3, after = 1.
    const resolveAction = (mod) => mod === 'lint' ? 'suppress' : 'trust';
    const out = applyConfidenceToScan(sampleScan, resolveAction);
    assert.strictEqual(out.scanResult.totalIssues, 1);
  });

  it('keeps perModule audit trail of every adjustment', () => {
    const resolveAction = (mod) => mod === 'lint' ? 'suppress' : 'trust';
    const out = applyConfidenceToScan(sampleScan, resolveAction);
    assert.strictEqual(out.adjustments.perModule.length, 1);
    assert.strictEqual(out.adjustments.perModule[0].module, 'lint');
    assert.strictEqual(out.adjustments.perModule[0].suppressed.length, 2);
  });

  it('handles missing scanResult / non-array modules', () => {
    const a = applyConfidenceToScan(null, () => 'trust');
    assert.strictEqual(a.scanResult, null);
    assert.strictEqual(a.adjustments.suppressedCount, 0);

    const b = applyConfidenceToScan({ modules: 'not an array' }, () => 'trust');
    assert.strictEqual(b.adjustments.suppressedCount, 0);
  });
});

// ---------- buildResolveAction ----------

describe('buildResolveAction', () => {
  it('returns a closure that calls getConfidenceScore and caches results', async () => {
    let callCount = 0;
    const fakeGet = async () => { callCount++; return { action: 'downgrade' }; };
    const resolve = buildResolveAction({
      sql: () => Promise.resolve([]),
      getConfidenceScore: fakeGet,
    });
    const a = await resolve('lint', null);
    const b = await resolve('lint', null); // same key, should hit cache
    assert.strictEqual(a, 'downgrade');
    assert.strictEqual(b, 'downgrade');
    assert.strictEqual(callCount, 1, 'second lookup should hit the cache');
  });

  it('falls back to defaultAction when sql or getConfidenceScore missing', async () => {
    const noSql = buildResolveAction({});
    assert.strictEqual(await noSql('lint'), 'trust');

    const customDefault = buildResolveAction({ defaultAction: 'suppress' });
    assert.strictEqual(await customDefault('lint'), 'suppress');
  });

  it('falls back to defaultAction on lookup error (brain unavailable)', async () => {
    const fakeGet = async () => { throw new Error('db down'); };
    const resolve = buildResolveAction({
      sql: () => Promise.resolve([]),
      getConfidenceScore: fakeGet,
    });
    const action = await resolve('lint', null);
    assert.strictEqual(action, 'trust');
  });
});
