// ============================================================================
// FIX-LOOP RELIABILITY TEST
// ============================================================================
// Guards against the regression Craig screenshotted on 2026-04-30:
// "0 done · 14 retry" — every fix batch returning failure with no useful
// signal. Root cause was situational (Anthropic / undici TLS), but the
// shape of the test that catches it is generic:
//
//   "When given a known-fixable input + a deterministic Claude that returns
//   a sane fix, the fix loop must report at least 1 success. Silently
//   returning 0 successes for valid input is a P0 bug."
//
// The test bypasses the route layer (no Vercel/Next.js needed) and exercises
// the inner attemptFixWithRetries directly with controlled inputs. If the
// helper's behaviour ever drifts to "always returns success: false" on
// happy-path input, this test fails and the build is red.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { attemptFixWithRetries, summariseAttempts } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'fix-attempt-loop.js'
));

// Minimal stand-in for the route's validateFix + verifyFixQuality helpers.
function validateFix(original, fixed) {
  if (!fixed || fixed.length === 0) return { ok: false, reason: 'empty' };
  if (fixed === original) return { ok: false, reason: 'no changes' };
  return { ok: true };
}
function verifyFixQuality(fixed) {
  // Reject obvious symptom-patches.
  if (/console\.log/.test(fixed)) return { clean: false, newIssues: ['console.log introduced'] };
  if (/debugger/.test(fixed)) return { clean: false, newIssues: ['debugger introduced'] };
  return { clean: true, newIssues: [] };
}

// ---------- HAPPY-PATH RELIABILITY CONTRACT ----------

describe('fix-loop reliability — happy path', () => {
  test('A deterministic Claude that returns a clean fix MUST produce success: true', async () => {
    const original = `function foo() {\n  var x = 1;\n  return x;\n}\n`;
    const fixed = `function foo() {\n  const x = 1;\n  return x;\n}\n`;

    const result = await attemptFixWithRetries({
      askClaude: async () => fixed,
      validateFix,
      verifyFixQuality,
      originalContent: original,
      filePath: 'src/foo.js',
      issues: ['error: src/foo.js:2 — no-var: uses var'],
      maxAttempts: 3,
    });

    // The hard contract: this MUST succeed. If we ever drift to false here,
    // the bug Craig screenshotted has come back and we ship blocked.
    assert.strictEqual(result.success, true, `RELIABILITY FAILURE: deterministic happy-path returned success=false. Final reason: ${result.finalReason}. Attempts: ${JSON.stringify(result.attempts)}`);
    assert.strictEqual(result.fixed, fixed);
    assert.ok(Array.isArray(result.attempts) && result.attempts.length >= 1);
    assert.strictEqual(result.attempts[0].outcome, 'success');
  });

  test('A deterministic Claude across multiple files all succeed (batch happy path)', async () => {
    const inputs = [
      { file: 'src/a.js', original: 'var a=1;', fixed: 'const a=1;', issue: 'no-var' },
      { file: 'src/b.js', original: 'var b=2;', fixed: 'const b=2;', issue: 'no-var' },
      { file: 'src/c.js', original: 'var c=3;', fixed: 'const c=3;', issue: 'no-var' },
    ];
    const results = await Promise.all(inputs.map(async (i) =>
      attemptFixWithRetries({
        askClaude: async () => i.fixed,
        validateFix,
        verifyFixQuality,
        originalContent: i.original,
        filePath: i.file,
        issues: [i.issue],
        maxAttempts: 3,
      })
    ));

    const successes = results.filter((r) => r.success).length;
    assert.strictEqual(successes, 3, `RELIABILITY FAILURE: expected 3/3 successes on deterministic batch, got ${successes}/3. This is the "0 done · 14 retry" shape — investigate immediately.`);
  });

  test('When Claude introduces a quality regression then fixes it on RETRY, the loop reports success', async () => {
    // Quality-fail (not validation-fail) is the retry path — validation
    // failures bail because a refusal/empty Claude response won't fix
    // itself by re-asking. Quality regressions DO retry because Claude
    // can be told what it introduced and self-correct.
    const original = 'var x=1;';
    let calls = 0;
    const askClaude = async () => {
      calls++;
      if (calls === 1) return 'const x=1; console.log(x);'; // quality-fail
      return 'const x=1;'; // clean
    };
    const result = await attemptFixWithRetries({
      askClaude,
      validateFix,
      verifyFixQuality,
      originalContent: original,
      filePath: 'src/x.js',
      issues: ['no-var'],
      maxAttempts: 3,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts.length, 2);
    assert.strictEqual(result.attempts[0].outcome, 'quality-fail');
    assert.strictEqual(result.attempts[1].outcome, 'success');
  });
});

// ---------- HONEST-FAILURE PATH ----------

describe('fix-loop reliability — honest failure surfaces', () => {
  test('When Claude consistently throws (Anthropic 503), all attempts surface as claude-error', async () => {
    const result = await attemptFixWithRetries({
      askClaude: async () => { throw new Error('Anthropic 503'); },
      validateFix,
      verifyFixQuality,
      originalContent: 'var x=1;',
      filePath: 'src/x.js',
      issues: ['no-var'],
      maxAttempts: 3,
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.attempts.length, 3);
    for (const a of result.attempts) {
      assert.strictEqual(a.outcome, 'claude-error');
    }
    // Critical: when ALL attempts are claude-error, the route layer
    // detects this and queues the file for retry rather than marking
    // it permanently failed. The shape of the result must support that.
    const allClaudeErrors = result.attempts.every((a) => a.outcome === 'claude-error');
    assert.strictEqual(allClaudeErrors, true,
      'all-claude-error detection is the signal the route uses to queue for retry; if this shape changes, the failedFiles[] surfacing breaks');
  });

  test('When Claude returns symptom-patches, the loop detects the quality regression', async () => {
    const original = 'function foo() { /* TODO */ }';
    const fixed = 'function foo() { console.log("debug"); }'; // adds console.log
    const result = await attemptFixWithRetries({
      askClaude: async () => fixed,
      validateFix,
      verifyFixQuality,
      originalContent: original,
      filePath: 'src/foo.js',
      issues: ['fix the TODO'],
      maxAttempts: 2,
    });
    assert.strictEqual(result.success, false);
    // Every attempt should fail with quality-fail, not slip through
    for (const a of result.attempts) {
      assert.strictEqual(a.outcome, 'quality-fail');
      assert.ok(a.qualityIssues.some((i) => i.includes('console.log')));
    }
  });
});

// ---------- summariseAttempts ----------

describe('summariseAttempts — diagnostic visibility', () => {
  test('returns a non-empty summary string for any input including empty arrays', () => {
    const empty = summariseAttempts([]);
    assert.strictEqual(typeof empty, 'string');
    assert.ok(empty.length > 0);

    const oneSuccess = summariseAttempts([
      { attemptNumber: 1, durationMs: 250, outcome: 'success' },
    ]);
    assert.match(oneSuccess, /1×\s+success/);
    assert.match(oneSuccess, /250ms/);
  });

  test('counts mixed outcomes correctly', () => {
    const summary = summariseAttempts([
      { attemptNumber: 1, durationMs: 100, outcome: 'validation-fail' },
      { attemptNumber: 2, durationMs: 200, outcome: 'quality-fail' },
      { attemptNumber: 3, durationMs: 300, outcome: 'success' },
    ]);
    assert.match(summary, /1×\s+validation-fail/);
    assert.match(summary, /1×\s+quality-fail/);
    assert.match(summary, /1×\s+success/);
    assert.match(summary, /600ms/);
  });
});

// ---------- META-CONTRACT ----------
// The shape the route depends on must not drift. If any of these
// assertions fail, the route layer breaks even if individual unit
// tests pass.

describe('fix-attempt-loop meta-contract — shape the route depends on', () => {
  test('result has the keys the route reads', async () => {
    const result = await attemptFixWithRetries({
      askClaude: async () => 'const x=1;',
      validateFix,
      verifyFixQuality,
      originalContent: 'var x=1;',
      filePath: 'src/x.js',
      issues: ['no-var'],
      maxAttempts: 1,
    });
    // Route reads: result.success, result.fixed, result.attempts,
    // result.attempts[i].outcome, result.attempts[i].claudeError,
    // result.finalReason
    assert.ok('success' in result);
    assert.ok('fixed' in result);
    assert.ok(Array.isArray(result.attempts));
    assert.ok('finalReason' in result);
    for (const a of result.attempts) {
      assert.ok('attemptNumber' in a);
      assert.ok('durationMs' in a);
      assert.ok('outcome' in a);
      assert.ok('validationReason' in a);
      assert.ok('qualityIssues' in a);
      assert.ok('claudeError' in a);
    }
  });
});
