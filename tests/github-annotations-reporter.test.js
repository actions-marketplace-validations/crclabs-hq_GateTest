const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GithubAnnotationsReporter } = require('../src/reporters/github-annotations-reporter');

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

function makeRunner() {
  return new EventEmitter();
}

function makeCheck({ name, severity, file, line, message, confidence }) {
  return {
    name,
    severity,
    file,
    line,
    message,
    confidence,
    passed: false,
    suggestion: null,
  };
}

test('emits ::error workflow command for failing error-severity check with file+line', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{
        module: 'security',
        checks: [makeCheck({
          name: 'hardcoded-secret',
          severity: 'error',
          file: 'src/foo.js',
          line: 42,
          message: 'AWS key in source',
          confidence: 0.95,
        })],
      }],
    });
  });

  assert.match(out, /^::error file=src\/foo\.js,line=42,col=1,title=GateTest \/ security \/ hardcoded-secret::AWS key in source\n$/);
});

test('warning severity emits ::warning', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{
        module: 'lint',
        checks: [makeCheck({
          name: 'unused-var',
          severity: 'warning',
          file: 'src/bar.js',
          line: 5,
          message: 'x is declared but never used',
          confidence: 0.8,
        })],
      }],
    });
  });

  assert.match(out, /^::warning /);
});

test('info severity emits ::notice', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{
        module: 'syntax',
        checks: [makeCheck({
          name: 'style',
          severity: 'info',
          file: 'src/baz.js',
          line: 1,
          message: 'minor',
          confidence: 0.5,
        })],
      }],
    });
  });

  assert.match(out, /^::notice /);
});

test('skips passing checks', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{
        module: 'security',
        checks: [{ ...makeCheck({ name: 'ok', severity: 'error', file: 'a.js', line: 1, message: 'ok', confidence: 1 }), passed: true }],
      }],
    });
  });

  assert.equal(out, '');
});

test('caps at 10 annotations per severity and surfaces overflow notice', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const checks = [];
  for (let i = 0; i < 15; i++) {
    checks.push(makeCheck({
      name: `err${i}`,
      severity: 'error',
      file: `src/file${i}.js`,
      line: i + 1,
      message: `msg ${i}`,
      confidence: 0.5,
    }));
  }

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{ module: 'm', checks }],
    });
  });

  const errorLines = out.split('\n').filter((l) => l.startsWith('::error '));
  assert.equal(errorLines.length, 10, '10 error annotations land');
  assert.match(out, /::notice::5 additional error finding\(s\) omitted/);
});

test('sorts by confidence descending so highest-confidence findings land within budget', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const checks = [];
  for (let i = 0; i < 12; i++) {
    checks.push(makeCheck({
      name: `e${i}`,
      severity: 'error',
      file: `f${i}.js`,
      line: 1,
      message: `m${i}`,
      // Confidence is 0.1 for i=0..1 (low) and 0.9 for i=2..11 (high)
      confidence: i < 2 ? 0.1 : 0.9,
    }));
  }

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{ module: 'm', checks }],
    });
  });

  // The two low-confidence checks (e0, e1) should NOT appear in the 10
  // that land within budget — they're in the overflow.
  assert.doesNotMatch(out, /title=GateTest \/ m \/ e0::/);
  assert.doesNotMatch(out, /title=GateTest \/ m \/ e1::/);
});

test('escapes : and , in title (property position) and %0A in message (data position)', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{
        module: 'mod:with:colons',
        checks: [makeCheck({
          name: 'rule,with,commas',
          severity: 'error',
          file: 'a.js',
          line: 1,
          message: 'line1\nline2',
          confidence: 1,
        })],
      }],
    });
  });

  // Title should have its colons and commas escaped (property position).
  // `/` is not a delimiter and stays literal.
  assert.match(out, /title=GateTest \/ mod%3Awith%3Acolons \/ rule%2Cwith%2Ccommas/);
  // Message should have its newline escaped (data position).
  assert.match(out, /::line1%0Aline2\n$/);
});

test('omits file= when check has no file', () => {
  const runner = makeRunner();
  new GithubAnnotationsReporter(runner);

  const out = captureStdout(() => {
    runner.emit('suite:end', {
      results: [{
        module: 'config',
        checks: [makeCheck({
          name: 'global',
          severity: 'error',
          file: null,
          line: null,
          message: 'config-level finding',
          confidence: 0.9,
        })],
      }],
    });
  });

  // file=... should be absent; line= and col= still present (default 1).
  assert.doesNotMatch(out, /file=/);
  assert.match(out, /^::error line=1,col=1,/);
});
