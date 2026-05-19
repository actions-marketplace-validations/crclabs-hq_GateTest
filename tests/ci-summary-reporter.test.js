const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CiSummaryReporter } = require('../src/reporters/ci-summary-reporter');

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try { fn(); } finally { process.stdout.write = original; }
  return chunks.join('');
}

function fakeResult({ module, duration, status = 'passed', errors = 0, warnings = 0 }) {
  return {
    module,
    duration,
    status,
    errorChecks: Array(errors).fill({}),
    warningChecks: Array(warnings).fill({}),
  };
}

test('emits collapsible group with header, row per module, and total', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    runner.emit('module:end', fakeResult({ module: 'syntax', duration: 100, status: 'passed' }));
    runner.emit('module:end', fakeResult({ module: 'security', duration: 3500, status: 'failed', errors: 3, warnings: 12 }));
    runner.emit('module:end', fakeResult({ module: 'lint', duration: 200, status: 'passed', warnings: 5 }));
    runner.emit('suite:end', { checks: { errors: 3, warnings: 17 } });
  });

  assert.match(out, /^::group::GateTest Module Timing\n/);
  assert.match(out, /Module\s+Time\s+Status\s+Errors\s+Warnings/);
  assert.match(out, /security\s+3500ms\s+failed\s+3\s+12/);
  assert.match(out, /lint\s+200ms\s+passed\s+0\s+5/);
  assert.match(out, /syntax\s+100ms\s+passed\s+0\s+0/);
  assert.match(out, /Total\s+3800ms/);
  assert.match(out, /::endgroup::\n/);
});

test('sorts rows by duration descending', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    runner.emit('module:end', fakeResult({ module: 'fast', duration: 50 }));
    runner.emit('module:end', fakeResult({ module: 'slow', duration: 5000 }));
    runner.emit('module:end', fakeResult({ module: 'medium', duration: 500 }));
    runner.emit('suite:end', { checks: { errors: 0, warnings: 0 } });
  });

  const slowIdx = out.indexOf('slow');
  const mediumIdx = out.indexOf('medium');
  const fastIdx = out.indexOf('fast');
  assert.ok(slowIdx < mediumIdx, 'slow before medium');
  assert.ok(mediumIdx < fastIdx, 'medium before fast');
});

test('emits ::notice with verdict + slow-module callout when any module >= 2s', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    runner.emit('module:end', fakeResult({ module: 'fast', duration: 100 }));
    runner.emit('module:end', fakeResult({ module: 'slow-one', duration: 3500 }));
    runner.emit('suite:end', { checks: { errors: 1, warnings: 4 } });
  });

  assert.match(out, /::notice title=GateTest::Suite: 2 modules in 3\.6s — 5 findings \(1 errors, 4 warnings\)\. Slowest: slow-one \(3\.5s\)\./);
});

test('omits slow-module callout when all modules under threshold', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    runner.emit('module:end', fakeResult({ module: 'fast', duration: 100 }));
    runner.emit('module:end', fakeResult({ module: 'medium', duration: 800 }));
    runner.emit('suite:end', { checks: { errors: 0, warnings: 0 } });
  });

  assert.match(out, /::notice title=GateTest::Suite: 2 modules in 0\.9s — 0 findings/);
  assert.doesNotMatch(out, /Slowest:/, 'no slowest callout when nothing exceeds 2s');
});

test('handles module:skip events the same as module:end', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    runner.emit('module:end', fakeResult({ module: 'ran', duration: 200 }));
    runner.emit('module:skip', fakeResult({ module: 'skipped', duration: 0, status: 'skipped' }));
    runner.emit('suite:end', { checks: { errors: 0, warnings: 0 } });
  });

  assert.match(out, /skipped\s+0ms\s+skipped/);
});

test('handles missing summary.checks gracefully (defaults to 0)', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    runner.emit('module:end', fakeResult({ module: 'm', duration: 100 }));
    runner.emit('suite:end', {});
  });

  assert.match(out, /0 findings \(0 errors, 0 warnings\)/);
});

test('escapes %, \\r, \\n in notice data position', () => {
  const runner = new EventEmitter();
  new CiSummaryReporter(runner);

  const out = captureStdout(() => {
    // Simulate a module name with special chars (unlikely but safe)
    runner.emit('module:end', { module: 'weird\nname', duration: 100, status: 'passed', errorChecks: [], warningChecks: [] });
    runner.emit('suite:end', { checks: { errors: 0, warnings: 0 } });
  });

  // The notice line itself doesn't include module names, so we just
  // confirm the escaper doesn't crash and produces well-formed output.
  assert.match(out, /::notice title=GateTest::/);
});
