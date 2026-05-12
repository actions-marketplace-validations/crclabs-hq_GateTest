/**
 * Adaptive-concurrency worker pool with mid-run throttle support.
 *
 * Extracted from website/app/api/scan/fix/route.ts for independent testability
 * (pure JS, no Next.js/TS transform required).
 *
 * Why this exists: Anthropic API can fail in correlated bursts (SSL alerts,
 * rate-limit waves). When that happens, parallel requests poison each other —
 * the fix is to drop concurrency from N → 1 mid-run and let backoff do the
 * work. The pool watches `state.activeConcurrency` on every loop iteration
 * and shrinks the live worker set to honour the new cap.
 *
 * Race-condition fix (HIGH-severity): the previous implementation let any
 * worker that observed `activeWorkers > activeConcurrency` exit. Two workers
 * could observe this simultaneously and both exit, stalling the cursor with
 * items still queued.
 *
 * Strategy (Option A — atomic check-and-decrement): when a worker observes
 * over-capacity it MUST atomically decrement before returning. Combined with
 * the "last-worker-stays" rule (`activeWorkers > 1` before the decrement),
 * this prevents the dual-exit race: even if two workers see `activeWorkers > cap`
 * simultaneously, the second one's check will see the first's already-applied
 * decrement and stay alive. The last worker stays regardless of the cap —
 * `activeConcurrency` is a CEILING, not a floor.
 *
 * Invariant: `activeWorkers >= 0` at every transition. Asserted inline.
 *
 * Note: JavaScript's single-threaded event loop means increments/decrements
 * are atomic with respect to each other; the race is purely between the
 * `await fn(...)` resumption points where multiple microtasks resolve in
 * sequence. The atomic check-and-decrement here means once a worker has
 * decided to exit and adjusted the count, no other worker observes the
 * stale pre-decrement value.
 */

'use strict';

function assertNonNegative(value, label) {
  if (value < 0) {
    throw new Error(
      `adaptive-concurrency invariant violated: ${label} went negative (${value})`,
    );
  }
}

/**
 * Run `fn` over `items` with up to `initialLimit` workers. The shared `state`
 * object is passed to every `fn` call so the user's worker can mutate
 * `state.activeConcurrency` (throttle down) or `state.haltRun` (abort) and the
 * pool will react on the next loop iteration.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} initialLimit
 * @param {(item: T, state: object) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithAdaptiveConcurrency(items, initialLimit, fn, opts = {}) {
  // Ramp-up: after N consecutive successes (no network error / no halt),
  // raise the ceiling by 1, capped at maxConcurrency. This claws back the
  // throughput we lost by starting conservatively at 2. Defaults bake in
  // a "ramp every 4 successes, never above 5" policy that empirically
  // doubles throughput in the typical happy-path while preserving the
  // "drop to 1 on EPROTO" safety net.
  const RAMP_AFTER_SUCCESSES = opts.rampAfterSuccesses ?? 4;
  const MAX_CONCURRENCY = opts.maxConcurrency ?? 5;

  const results = new Array(items.length);
  const state = {
    consecutiveNetworkErrors: 0,
    consecutiveSuccesses: 0,
    activeConcurrency: initialLimit,
    haltRun: false,
  };
  let cursor = 0;
  let activeWorkers = 0;
  let pendingSpawn = 0; // workers we've decided to spawn but haven't yet

  // After a worker completes successfully, consider whether to spawn a new
  // one. This is the upward-adaptation path: if the run is healthy, raise
  // the ceiling and start an extra worker so the cursor drains faster.
  // CRITICAL: only ramp up when no network errors have happened in this
  // run AND when the caller hasn't explicitly dropped activeConcurrency
  // below the initial limit. The drop-to-1 safety net (used when EPROTO
  // / TLS pool poisoning is detected) must never be undone by ramp-up,
  // or we'd cascade-fail right back into the same pool-poisoning state.
  function maybeRampUp(spawnFn) {
    if (state.consecutiveNetworkErrors > 0) return;
    if (state.activeConcurrency < initialLimit) return;
    if (
      state.consecutiveSuccesses >= RAMP_AFTER_SUCCESSES &&
      state.activeConcurrency < MAX_CONCURRENCY &&
      cursor < items.length &&
      !state.haltRun
    ) {
      state.activeConcurrency += 1;
      state.consecutiveSuccesses = 0;
      // Spawn a fresh worker if we're below the new ceiling.
      if (activeWorkers + pendingSpawn < state.activeConcurrency) {
        pendingSpawn += 1;
        spawnFn();
      }
    }
  }

  async function worker(spawnFn) {
    activeWorkers++;
    if (pendingSpawn > 0) pendingSpawn -= 1;
    assertNonNegative(activeWorkers, 'activeWorkers (post-increment)');
    let exitedEarly = false;
    try {
      while (cursor < items.length && !state.haltRun) {
        // Honour dynamic throttling, but only if there's at least one OTHER
        // worker still alive. The last worker stays — `activeConcurrency` is
        // a ceiling, not a floor. Without this guard, two workers can race
        // on the over-cap check and both exit, stalling the cursor.
        //
        // ATOMIC: in the same JS turn (no `await` between check and the
        // decrement) we both verify over-capacity AND drop the count. The
        // next worker that resumes from its `await` will observe the new
        // count and re-evaluate — guaranteeing at most ONE worker exits
        // per over-cap event.
        if (activeWorkers > state.activeConcurrency && activeWorkers > 1) {
          activeWorkers--;
          assertNonNegative(activeWorkers, 'activeWorkers (early-exit decrement)');
          exitedEarly = true;
          return;
        }
        const idx = cursor++;
        const errorsBefore = state.consecutiveNetworkErrors;
        results[idx] = await fn(items[idx], state);
        // If `fn` didn't bump consecutiveNetworkErrors, count it as a
        // success — even if `fn` recorded other failure modes (claude-error,
        // validation-fail), those don't justify dropping concurrency.
        if (state.consecutiveNetworkErrors === errorsBefore) {
          state.consecutiveSuccesses += 1;
          maybeRampUp(spawnFn);
        }
      }
    } finally {
      if (!exitedEarly) {
        activeWorkers--;
        assertNonNegative(activeWorkers, 'activeWorkers (post-decrement)');
      }
    }
  }

  const workerPromises = [];
  function spawnFn() {
    workerPromises.push(worker(spawnFn));
  }
  const startCount = Math.min(initialLimit, items.length);
  for (let i = 0; i < startCount; i++) spawnFn();
  // Drain — Promise.all on a live array doesn't pick up additions after
  // its initial pass, so loop until the array stops growing.
  while (workerPromises.length > 0) {
    const snapshot = workerPromises.splice(0, workerPromises.length);
    await Promise.all(snapshot);
  }
  return results;
}

module.exports = { mapWithAdaptiveConcurrency };
