// =============================================================================
// BUDGET-TRACKER TEST — website/app/lib/budget-tracker.js
// =============================================================================
// Per-scan Anthropic spend cap. Tracker is in-process (one per request) and
// throws BUDGET_EXCEEDED on the NEXT preflight() once total tokens or USD
// crosses the configured ceiling.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  BudgetTracker,
  createBudgetTracker,
  getCurrentTracker,
  runWithTracker,
  estimateTokens,
  INPUT_USD_PER_MTOK,
  OUTPUT_USD_PER_MTOK,
  CHARS_PER_TOKEN,
} = require('../website/app/lib/budget-tracker');

describe('estimateTokens', () => {
  it('returns 0 for empty / null', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  it('rounds up — never under-counts', () => {
    // CHARS_PER_TOKEN = 3, so 4 chars must be at least 2 tokens (ceil).
    assert.equal(estimateTokens('abcd'), Math.ceil(4 / CHARS_PER_TOKEN));
  });

  it('scales linearly with length', () => {
    const a = estimateTokens('x'.repeat(300));
    const b = estimateTokens('x'.repeat(600));
    assert.equal(b, 2 * a);
  });
});

describe('BudgetTracker — basic accounting', () => {
  it('starts at zero on all counters', () => {
    const t = new BudgetTracker();
    const s = t.snapshot();
    assert.equal(s.callCount, 0);
    assert.equal(s.inputTokens, 0);
    assert.equal(s.outputTokens, 0);
    assert.equal(s.totalTokens, 0);
    assert.equal(s.estimatedUsd, 0);
    assert.equal(s.aborted, false);
    assert.equal(s.abortReason, null);
  });

  it('prefers Anthropic-reported usage over char estimation', () => {
    const t = new BudgetTracker();
    const body = 'x'.repeat(900); // would estimate 300 tokens
    t.record(body, { data: { usage: { input_tokens: 100, output_tokens: 50 } } });
    assert.equal(t.inputTokens, 100, 'uses usage.input_tokens, not estimate');
    assert.equal(t.outputTokens, 50);
    assert.equal(t.callCount, 1);
  });

  it('falls back to char estimation when usage is absent', () => {
    const t = new BudgetTracker();
    const body = 'x'.repeat(900);
    t.record(body, { data: { content: [{ type: 'text', text: 'y'.repeat(300) }] } });
    assert.equal(t.inputTokens, estimateTokens(body));
    assert.equal(t.outputTokens, estimateTokens('y'.repeat(300)));
  });

  it('handles null response gracefully (estimates from body only)', () => {
    const t = new BudgetTracker();
    t.record('x'.repeat(300), null);
    assert.equal(t.inputTokens, estimateTokens('x'.repeat(300)));
    assert.equal(t.outputTokens, 0);
  });

  it('estimatedUsd applies the two price rates correctly', () => {
    const t = new BudgetTracker();
    // 1M input tokens, 1M output tokens
    t.record('', { data: { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } });
    const expected = INPUT_USD_PER_MTOK + OUTPUT_USD_PER_MTOK;
    assert.equal(t.estimatedUsd(), expected);
  });
});

describe('BudgetTracker — token cap', () => {
  it('aborts when total tokens cross maxTokens', () => {
    const t = new BudgetTracker({ maxTokens: 100, maxUsd: 1_000 });
    t.record('', { data: { usage: { input_tokens: 60, output_tokens: 50 } } });
    assert.equal(t.aborted, true);
    assert.match(t.abortReason, /token cap exceeded/);
  });

  it('does NOT abort below the cap', () => {
    const t = new BudgetTracker({ maxTokens: 1000, maxUsd: 1_000 });
    t.record('', { data: { usage: { input_tokens: 100, output_tokens: 200 } } });
    assert.equal(t.aborted, false);
  });

  it('aborted stays sticky — later under-budget calls do not un-abort', () => {
    const t = new BudgetTracker({ maxTokens: 50, maxUsd: 1_000 });
    t.record('', { data: { usage: { input_tokens: 100, output_tokens: 100 } } });
    assert.equal(t.aborted, true);
    const reasonBefore = t.abortReason;
    t.record('', { data: { usage: { input_tokens: 0, output_tokens: 0 } } });
    assert.equal(t.aborted, true);
    assert.equal(t.abortReason, reasonBefore);
  });
});

describe('BudgetTracker — usd cap', () => {
  it('aborts when estimated USD crosses maxUsd', () => {
    const t = new BudgetTracker({ maxTokens: 10_000_000, maxUsd: 1 });
    // 200k output tokens at $15/MTok = $3 > $1 cap
    t.record('', { data: { usage: { input_tokens: 0, output_tokens: 200_000 } } });
    assert.equal(t.aborted, true);
    assert.match(t.abortReason, /usd cap exceeded/);
  });

  it('does NOT abort when under both caps', () => {
    const t = new BudgetTracker({ maxTokens: 10_000_000, maxUsd: 10 });
    t.record('', { data: { usage: { input_tokens: 1000, output_tokens: 1000 } } });
    assert.equal(t.aborted, false);
  });
});

describe('BudgetTracker — preflight', () => {
  it('preflight() is a no-op when not aborted', () => {
    const t = new BudgetTracker();
    assert.doesNotThrow(() => t.preflight());
  });

  it('preflight() throws BUDGET_EXCEEDED with snapshot once aborted', () => {
    const t = new BudgetTracker({ maxTokens: 50, maxUsd: 1_000 });
    t.record('', { data: { usage: { input_tokens: 100, output_tokens: 100 } } });
    let err;
    try { t.preflight(); } catch (e) { err = e; }
    assert.ok(err, 'preflight threw');
    assert.equal(err.code, 'BUDGET_EXCEEDED');
    assert.ok(err.tracker, 'error carries snapshot');
    assert.equal(err.tracker.aborted, true);
    assert.equal(err.tracker.callCount, 1);
    assert.match(err.message, /budget exhausted/);
  });
});

describe('BudgetTracker — snapshot shape', () => {
  it('snapshot contains every field a caller might need', () => {
    const t = new BudgetTracker({ label: 'unit-test' });
    t.record('abc', { data: { usage: { input_tokens: 10, output_tokens: 20 } } });
    const s = t.snapshot();
    assert.equal(s.label, 'unit-test');
    assert.equal(s.callCount, 1);
    assert.equal(s.inputTokens, 10);
    assert.equal(s.outputTokens, 20);
    assert.equal(s.totalTokens, 30);
    assert.ok(typeof s.estimatedUsd === 'number');
    assert.ok(typeof s.maxTokens === 'number');
    assert.ok(typeof s.maxUsd === 'number');
    assert.equal(s.aborted, false);
    assert.equal(s.abortReason, null);
    assert.ok(typeof s.durationMs === 'number');
    assert.ok(s.durationMs >= 0);
  });
});

describe('createBudgetTracker — factory', () => {
  it('returns a BudgetTracker instance with passed opts honoured', () => {
    const t = createBudgetTracker({ maxTokens: 999, maxUsd: 5, label: 'foo' });
    assert.ok(t instanceof BudgetTracker);
    assert.equal(t.maxTokens, 999);
    assert.equal(t.maxUsd, 5);
    assert.equal(t.label, 'foo');
  });

  it('uses env-default caps when no opts passed', () => {
    const t = createBudgetTracker();
    assert.ok(t.maxTokens > 0);
    assert.ok(t.maxUsd > 0);
  });
});

describe('AsyncLocalStorage context', () => {
  it('getCurrentTracker returns null outside runWithTracker', () => {
    assert.equal(getCurrentTracker(), null);
  });

  it('getCurrentTracker returns the active tracker inside runWithTracker', () => {
    const t = createBudgetTracker();
    runWithTracker(t, () => {
      assert.equal(getCurrentTracker(), t);
    });
  });

  it('different runWithTracker calls do NOT share trackers', () => {
    const t1 = createBudgetTracker({ label: 'a' });
    const t2 = createBudgetTracker({ label: 'b' });
    let seenA, seenB;
    runWithTracker(t1, () => { seenA = getCurrentTracker(); });
    runWithTracker(t2, () => { seenB = getCurrentTracker(); });
    assert.equal(seenA.label, 'a');
    assert.equal(seenB.label, 'b');
  });

  it('context persists across awaited microtasks (the whole point of ALS)', async () => {
    const t = createBudgetTracker({ label: 'async-test' });
    await runWithTracker(t, async () => {
      await Promise.resolve();
      assert.equal(getCurrentTracker()?.label, 'async-test');
      await new Promise((r) => setTimeout(r, 1));
      assert.equal(getCurrentTracker()?.label, 'async-test');
    });
  });

  it('returns the result of fn — works for sync values', () => {
    const t = createBudgetTracker();
    const result = runWithTracker(t, () => 42);
    assert.equal(result, 42);
  });

  it('returns the result of fn — works for promises', async () => {
    const t = createBudgetTracker();
    const result = await runWithTracker(t, async () => 'hello');
    assert.equal(result, 'hello');
  });
});

describe('BudgetTracker — realistic scan flow', () => {
  it('5 small calls under cap stay green', () => {
    const t = createBudgetTracker({ maxTokens: 10_000, maxUsd: 1 });
    for (let i = 0; i < 5; i++) {
      t.preflight();
      t.record('x'.repeat(100), { data: { usage: { input_tokens: 50, output_tokens: 100 } } });
    }
    assert.equal(t.aborted, false);
    assert.equal(t.snapshot().callCount, 5);
  });

  it('runaway loop trips abort on the 6th call', () => {
    const t = createBudgetTracker({ maxTokens: 1000, maxUsd: 1 });
    let callsMade = 0;
    let blocked = false;
    for (let i = 0; i < 20; i++) {
      try {
        t.preflight();
        callsMade++;
        t.record('', { data: { usage: { input_tokens: 100, output_tokens: 100 } } });
      } catch (e) {
        if (e.code === 'BUDGET_EXCEEDED') {
          blocked = true;
          break;
        }
        throw e;
      }
    }
    assert.equal(blocked, true, 'budget exceeded triggered');
    assert.ok(callsMade < 20, 'loop was cut short');
    assert.ok(callsMade >= 5, 'at least 5 calls fit before cap');
  });
});
