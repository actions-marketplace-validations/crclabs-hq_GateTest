'use strict';

/**
 * Confidence-aware gate decision tests.
 *
 * Verifies that the runner blocks the gate ONLY when at least one
 * confident error exists (severity === 'error' AND confidence >= threshold).
 * Low-confidence errors are visible in the report but don't block.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GateTestRunner, TestResult } = require('../src/core/runner');
const { BLOCK_THRESHOLD } = require('../src/core/confidence');

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRunner(options = {}) {
  return new GateTestRunner(
    { projectRoot: process.cwd() },
    options,
  );
}

/**
 * Build a fake module that calls addCheck N times with given severities
 * and confidence values.
 */
function fakeModule(checks) {
  return {
    async run(result) {
      for (const c of checks) {
        result.addCheck(c.name || 'check', false, {
          severity: c.severity || 'error',
          confidence: c.confidence,
          message: c.message || 'something',
        });
      }
    },
  };
}

// ─── 5 errors at confidence 1.0 → BLOCKED ──────────────────────────────────

test('5 confident errors → gate BLOCKED', async () => {
  const runner = makeRunner();
  runner.register('m', fakeModule([
    { name: 'e1', confidence: 1.0 },
    { name: 'e2', confidence: 1.0 },
    { name: 'e3', confidence: 1.0 },
    { name: 'e4', confidence: 1.0 },
    { name: 'e5', confidence: 1.0 },
  ]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
  assert.equal(summary.checks.blockingErrors, 5);
  assert.equal(summary.checks.softErrors, 0);
});

// ─── 5 errors at confidence 0.4 → PASSED ────────────────────────────────────

test('5 low-confidence errors → gate PASSED (all soft)', async () => {
  const runner = makeRunner();
  runner.register('m', fakeModule([
    { name: 'e1', confidence: 0.4 },
    { name: 'e2', confidence: 0.4 },
    { name: 'e3', confidence: 0.4 },
    { name: 'e4', confidence: 0.4 },
    { name: 'e5', confidence: 0.4 },
  ]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'PASSED');
  assert.equal(summary.checks.blockingErrors, 0);
  assert.equal(summary.checks.softErrors, 5);
  // Total errors still 5 (visible in report)
  assert.equal(summary.checks.errors, 5);
});

// ─── Mixed: 2 confident + 3 soft → BLOCKED ─────────────────────────────────

test('mixed confident + soft errors → BLOCKED (any confident is enough)', async () => {
  const runner = makeRunner();
  runner.register('m', fakeModule([
    { name: 'e1', confidence: 1.0 },
    { name: 'e2', confidence: 1.0 },
    { name: 'e3', confidence: 0.3 },
    { name: 'e4', confidence: 0.3 },
    { name: 'e5', confidence: 0.3 },
  ]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
  assert.equal(summary.checks.blockingErrors, 2);
  assert.equal(summary.checks.softErrors, 3);
});

// ─── Custom threshold ───────────────────────────────────────────────────────

test('--confidence-threshold 0.9 makes 0.8 finding soft', async () => {
  const runner = makeRunner({ confidenceThreshold: 0.9 });
  runner.register('m', fakeModule([
    { name: 'e1', confidence: 0.8 },
  ]));
  const summary = await runner.run(['m']);
  // 0.8 < 0.9 threshold → soft
  assert.equal(summary.gateStatus, 'PASSED');
  assert.equal(summary.checks.softErrors, 1);
  assert.equal(summary.checks.blockingErrors, 0);
});

test('--confidence-threshold 0.5 lets confidence-0.6 finding block', async () => {
  const runner = makeRunner({ confidenceThreshold: 0.5 });
  runner.register('m', fakeModule([
    { name: 'e1', confidence: 0.6 },
  ]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
  assert.equal(summary.checks.blockingErrors, 1);
});

// ─── Default behaviour (no explicit confidence) ────────────────────────────

test('error with no confidence field defaults to confidence 1.0 → blocks', async () => {
  const runner = makeRunner();
  runner.register('m', fakeModule([
    { name: 'e1' }, // no confidence
  ]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
});

// ─── Warnings don't block regardless of confidence ─────────────────────────

test('warnings never block, even at confidence 1.0', async () => {
  const runner = makeRunner();
  runner.register('m', fakeModule([
    { name: 'w1', severity: 'warning', confidence: 1.0 },
    { name: 'w2', severity: 'warning', confidence: 1.0 },
  ]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'PASSED');
  assert.equal(summary.checks.warnings, 2);
  assert.equal(summary.checks.blockingErrors, 0);
});

// ─── Path-based auto-detection ─────────────────────────────────────────────

test('error in test file is auto-downgraded to soft via path signal', async () => {
  const runner = makeRunner();
  runner.register('m', {
    async run(result) {
      result.addCheck('test-finding', false, {
        severity: 'error',
        file: 'tests/foo.test.js',
        message: 'something',
      });
    },
  });
  const summary = await runner.run(['m']);
  // 1.0 * 0.6 (test) = 0.6 < 0.7 → soft
  assert.equal(summary.gateStatus, 'PASSED');
  assert.equal(summary.checks.softErrors, 1);
});

test('error in .md doc file is auto-downgraded to soft', async () => {
  const runner = makeRunner();
  runner.register('m', {
    async run(result) {
      result.addCheck('doc-finding', false, {
        severity: 'error',
        file: 'README.md',
        message: 'something',
      });
    },
  });
  const summary = await runner.run(['m']);
  // 1.0 * 0.3 (doc) = 0.3 < 0.7 → soft
  assert.equal(summary.gateStatus, 'PASSED');
});

test('error in real source file blocks the gate', async () => {
  const runner = makeRunner();
  runner.register('m', {
    async run(result) {
      result.addCheck('real-finding', false, {
        severity: 'error',
        file: 'src/lib/foo.js',
        message: 'real bug',
      });
    },
  });
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
  assert.equal(summary.checks.blockingErrors, 1);
});

// ─── TestResult shape ──────────────────────────────────────────────────────

test('TestResult exposes blockingErrorChecks and softErrorChecks', () => {
  const r = new TestResult('m', { blockThreshold: 0.7 });
  r.addCheck('e1', false, { severity: 'error', confidence: 1.0 });
  r.addCheck('e2', false, { severity: 'error', confidence: 0.3 });
  assert.equal(r.blockingErrorChecks.length, 1);
  assert.equal(r.softErrorChecks.length, 1);
});

test('TestResult.toJSON includes blocking and soft error counts', () => {
  const r = new TestResult('m', { blockThreshold: 0.7 });
  r.addCheck('e1', false, { severity: 'error', confidence: 1.0 });
  r.addCheck('e2', false, { severity: 'error', confidence: 0.3 });
  const j = r.toJSON();
  assert.equal(j.blockingErrors, 1);
  assert.equal(j.softErrors, 1);
  assert.equal(j.errors, 2);
});

test('summary.confidenceThreshold reflects runner option', async () => {
  const runner = makeRunner({ confidenceThreshold: 0.85 });
  runner.register('m', fakeModule([{ name: 'e1', confidence: 0.9 }]));
  const summary = await runner.run(['m']);
  assert.equal(summary.confidenceThreshold, 0.85);
});

// ─── Backwards compatibility ────────────────────────────────────────────────

test('legacy module without confidence field still blocks (no regression)', async () => {
  // Simulates an older module that doesn't pass confidence.
  const runner = makeRunner();
  runner.register('m', {
    async run(result) {
      // No file path either — no signals fire, defaults to 1.0.
      result.addCheck('legacy', false, {
        severity: 'error',
        message: 'legacy finding',
      });
    },
  });
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
});

test('module crash (thrown error) blocks the gate regardless of confidence', async () => {
  const runner = makeRunner();
  runner.register('m', {
    async run() {
      throw new Error('module crashed');
    },
  });
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
  assert.equal(summary.modules.failed, 1);
});

// ─── Default threshold ──────────────────────────────────────────────────────

test('runner uses BLOCK_THRESHOLD when no override given', async () => {
  const runner = makeRunner();
  // confidence 0.71 is just above default 0.7 → blocks
  runner.register('m', fakeModule([{ name: 'e1', confidence: 0.71 }]));
  const summary = await runner.run(['m']);
  assert.equal(summary.gateStatus, 'BLOCKED');
  assert.equal(summary.confidenceThreshold, BLOCK_THRESHOLD);
});
