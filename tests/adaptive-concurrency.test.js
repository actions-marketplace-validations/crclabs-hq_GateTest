// ============================================================================
// ADAPTIVE-CONCURRENCY TEST — race-fix coverage for the auto-fix worker pool
// ============================================================================
// Covers website/app/lib/adaptive-concurrency.js — the dual-exit race that
// could stall the auto-fix cursor when Anthropic API errors triggered a
// concurrency drop from 2 → 1. Both workers could observe "I'm over the
// cap" simultaneously and both exit, leaving queued files unprocessed.
//
// Fix verified: atomic check-and-decrement + last-worker-stays guarantees
// at most ONE worker exits per over-cap event, and at least ONE worker
// remains alive while the cursor has unprocessed items.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapWithAdaptiveConcurrency,
} = require('../website/app/lib/adaptive-concurrency.js');

// Helper: tiny deterministic queue-microtask delay.
const tick = () => new Promise((r) => setImmediate(r));

test('processes all items in order with no holes (baseline)', async () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const results = await mapWithAdaptiveConcurrency(items, 2, async (item) => {
    await tick();
    return item * 2;
  });
  assert.equal(results.length, 100);
  for (let i = 0; i < 100; i++) {
    assert.equal(results[i], i * 2, `index ${i} should be ${i * 2}, got ${results[i]}`);
  }
});

test('handles empty items array', async () => {
  const results = await mapWithAdaptiveConcurrency([], 4, async (i) => i);
  assert.deepEqual(results, []);
});

test('honours initialLimit when items < limit', async () => {
  const items = [1, 2, 3];
  const results = await mapWithAdaptiveConcurrency(items, 10, async (item) => item + 100);
  assert.deepEqual(results, [101, 102, 103]);
});

test('drop-to-1 mid-run: ALL items still processed (the bug)', async () => {
  // The exact scenario from the bug audit:
  //   - 2 workers running
  //   - Item 3 increments consecutiveNetworkErrors → 3, drops concurrency to 1
  //   - Both workers observe over-capacity on next loop
  //   - Both workers must NOT exit; cursor must reach end
  const items = Array.from({ length: 100 }, (_, i) => i);
  let activeFnInvocations = 0;
  let maxActiveFnInvocations = 0;
  let dropFiredAt = -1;

  const results = await mapWithAdaptiveConcurrency(items, 2, async (item, state) => {
    activeFnInvocations++;
    if (activeFnInvocations > maxActiveFnInvocations) {
      maxActiveFnInvocations = activeFnInvocations;
    }
    try {
      // Simulate a tiny network round-trip
      await tick();
      await tick();

      if (item === 3) {
        // Mock the network-error path: after 3 errors, drop to 1
        state.consecutiveNetworkErrors = 3;
        state.activeConcurrency = 1;
        dropFiredAt = item;
      }
      return item * 10;
    } finally {
      activeFnInvocations--;
    }
  });

  assert.equal(results.length, 100, 'results length must be 100');
  for (let i = 0; i < 100; i++) {
    assert.equal(results[i], i * 10, `index ${i} should be ${i * 10}, got ${results[i]}`);
  }
  assert.equal(dropFiredAt, 3, 'concurrency drop should have fired on item 3');
  assert(maxActiveFnInvocations <= 2, `max parallel fn invocations = ${maxActiveFnInvocations}, expected ≤ 2`);
});

test('after drop-to-1, only one worker is active at a time', async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const concurrencyObservedAfterDrop = [];
  let dropFired = false;
  let activeFnInvocations = 0;

  await mapWithAdaptiveConcurrency(items, 3, async (item, state) => {
    activeFnInvocations++;
    try {
      // Trip the drop early — at item 5 — so we have plenty of items left
      // to observe the post-drop concurrency cap.
      if (item === 5 && !dropFired) {
        state.activeConcurrency = 1;
        dropFired = true;
      }

      // Sample concurrency on every fn call AFTER the drop has fired.
      // We need a real await window so other workers can interleave.
      await tick();
      if (dropFired && item > 5) {
        concurrencyObservedAfterDrop.push(activeFnInvocations);
      }
      await tick();

      return item;
    } finally {
      activeFnInvocations--;
    }
  });

  // After the drop, peak observed concurrency must be 1.
  // (At least some samples must exist — guard against empty array.)
  assert(concurrencyObservedAfterDrop.length > 0, 'should have post-drop samples');
  const maxAfterDrop = Math.max(...concurrencyObservedAfterDrop);
  assert.equal(maxAfterDrop, 1, `post-drop max concurrency = ${maxAfterDrop}, expected 1`);
});

test('invariant: activeWorkers never goes negative', async () => {
  // The helper's internal assertNonNegative throws if the invariant breaks.
  // Run a stressful drop pattern and confirm no throw.
  const items = Array.from({ length: 200 }, (_, i) => i);
  await assert.doesNotReject(async () => {
    await mapWithAdaptiveConcurrency(items, 4, async (item, state) => {
      await tick();
      // Throttle aggressively at multiple points
      if (item === 10) state.activeConcurrency = 2;
      if (item === 30) state.activeConcurrency = 1;
      return item;
    });
  });
});

test('haltRun aborts processing — remaining items not run', async () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  let calls = 0;
  const results = await mapWithAdaptiveConcurrency(items, 2, async (item, state) => {
    calls++;
    if (item === 5) state.haltRun = true;
    return item;
  });
  assert(calls < 100, `expected halt to short-circuit, got ${calls} calls`);
  // results array still has length 100 but tail entries are `undefined`
  assert.equal(results.length, 100);
});

test('worker fn that throws on item 3 (network error) still completes the rest', async () => {
  // Per the spec: simulate a "network error" thrown by fn on item 3.
  // The route's real wrapper catches errors and increments
  // consecutiveNetworkErrors. Here we model a wrapper that does the same.
  const items = Array.from({ length: 100 }, (_, i) => i);
  const errorsObserved = [];

  const results = await mapWithAdaptiveConcurrency(items, 2, async (item, state) => {
    try {
      if (item === 3) {
        throw new Error('network error');
      }
      await tick();
      return item;
    } catch (err) {
      errorsObserved.push({ item, msg: err.message });
      state.consecutiveNetworkErrors = (state.consecutiveNetworkErrors || 0) + 1;
      // Mirror route.ts:783-784
      if (state.consecutiveNetworkErrors >= 3 && state.activeConcurrency > 1) {
        state.activeConcurrency = 1;
      }
      return null; // sentinel — fix failed for this item
    }
  });

  assert.equal(results.length, 100);
  assert.equal(results[3], null, 'item 3 should be sentinel-null after error');
  for (let i = 0; i < 100; i++) {
    if (i === 3) continue;
    assert.equal(results[i], i, `item ${i} should be processed`);
  }
  assert.equal(errorsObserved.length, 1);
  assert.equal(errorsObserved[0].item, 3);
});

test('stress: 1000 items with random network-error injection — all processed', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  // Seed-ish deterministic pseudo-random to keep test reproducible.
  let seed = 0xc0ffee;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const results = await mapWithAdaptiveConcurrency(items, 4, async (item, state) => {
    try {
      if (rand() < 0.05) {
        // ~5% network-error rate
        throw new Error('simulated network error');
      }
      // Vary work duration a bit
      const ticks = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < ticks; i++) await tick();
      return { ok: true, item };
    } catch {
      state.consecutiveNetworkErrors = (state.consecutiveNetworkErrors || 0) + 1;
      if (state.consecutiveNetworkErrors >= 3 && state.activeConcurrency > 1) {
        state.activeConcurrency = 1;
      }
      return { ok: false, item };
    }
  });

  assert.equal(results.length, 1000, 'every item must have a result entry');
  let okCount = 0;
  let errCount = 0;
  for (let i = 0; i < 1000; i++) {
    assert(results[i] != null, `index ${i} has a null result — cursor stalled`);
    assert.equal(results[i].item, i);
    if (results[i].ok) okCount++;
    else errCount++;
  }
  assert.equal(okCount + errCount, 1000);
  assert(errCount > 0, 'should have observed some simulated errors');
  assert(okCount > 0, 'should have observed some successes');
});

test('extreme race scenario: forced simultaneous over-cap observation', async () => {
  // Hand-crafted scenario: 4 workers, drop to 1 immediately on the FIRST
  // item that resolves. All workers will then observe activeWorkers=4 > 1
  // when they wake from their await. Without the atomic
  // check-and-decrement, multiple workers would exit and the cursor would
  // stall. With the fix, exactly the right number drain to leave 1 alive.
  const items = Array.from({ length: 200 }, (_, i) => i);
  let firstResolved = false;

  const results = await mapWithAdaptiveConcurrency(items, 4, async (item, state) => {
    await tick();
    if (!firstResolved) {
      firstResolved = true;
      state.activeConcurrency = 1;
    }
    await tick();
    return item;
  });

  assert.equal(results.length, 200);
  for (let i = 0; i < 200; i++) {
    assert.equal(results[i], i, `index ${i} stalled — value ${results[i]}`);
  }
});

test('drop then recover: concurrency restoration is honoured', async () => {
  // Caller drops to 1, then later raises back to 3. The pool was started
  // with 3 workers; after the recovery there should still be 3 workers
  // available (we never killed more than the over-supply demanded).
  // The contract: the helper is a CEILING, not a floor — it does NOT spawn
  // new workers on raise. But it also must not have killed workers it
  // didn't need to. Verify all items still process.
  const items = Array.from({ length: 100 }, (_, i) => i);
  const results = await mapWithAdaptiveConcurrency(items, 3, async (item, state) => {
    await tick();
    if (item === 5) state.activeConcurrency = 1;
    if (item === 50) state.activeConcurrency = 3;
    return item;
  });
  assert.equal(results.length, 100);
  for (let i = 0; i < 100; i++) {
    assert.equal(results[i], i);
  }
});

test('single-item input — works correctly', async () => {
  const results = await mapWithAdaptiveConcurrency([42], 4, async (item) => item + 1);
  assert.deepEqual(results, [43]);
});

test('initialLimit of 1 — sequential processing', async () => {
  const items = [10, 20, 30, 40, 50];
  let maxActive = 0;
  let active = 0;
  const results = await mapWithAdaptiveConcurrency(items, 1, async (item) => {
    active++;
    if (active > maxActive) maxActive = active;
    await tick();
    active--;
    return item / 10;
  });
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(maxActive, 1);
});

test('ramp-up: healthy run scales concurrency above initialLimit', async () => {
  // 50 items, initial 2, max 5, ramp every 4 successes — by the end
  // we should observe more than 2 in-flight workers at some point.
  const items = Array.from({ length: 50 }, (_, i) => i);
  let active = 0;
  let peak = 0;

  await mapWithAdaptiveConcurrency(items, 2, async (item) => {
    active++;
    if (active > peak) peak = active;
    await tick();
    await tick();
    active--;
    return item;
  });

  assert(peak > 2, `peak concurrency should exceed initial 2 after healthy run; got ${peak}`);
  assert(peak <= 5, `peak should not exceed max of 5; got ${peak}`);
});

test('ramp-up: a network-error run is NEVER ramped up after the drop', async () => {
  // Even after many post-drop successes, concurrency must stay where
  // the caller put it (1). This is the regression guard: ramp-up must
  // not undo the drop-to-1 safety net.
  const items = Array.from({ length: 80 }, (_, i) => i);
  let active = 0;
  let peakAfterDrop = 0;
  let dropped = false;

  await mapWithAdaptiveConcurrency(items, 2, async (item, state) => {
    active++;
    try {
      if (item === 5 && !dropped) {
        // Simulate the EPROTO trip: caller drops to 1 + flags errors
        state.consecutiveNetworkErrors = 3;
        state.activeConcurrency = 1;
        dropped = true;
      }
      await tick();
      if (dropped && item > 5 && active > peakAfterDrop) {
        peakAfterDrop = active;
      }
      return item;
    } finally {
      active--;
    }
  });

  assert(dropped, 'drop must have fired');
  assert.equal(peakAfterDrop, 1, `peak post-drop concurrency must be 1; got ${peakAfterDrop}`);
});
