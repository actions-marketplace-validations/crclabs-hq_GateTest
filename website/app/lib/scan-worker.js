/**
 * Pure helpers for the Signal Bus E1 worker tick at
 * `website/app/api/scan/worker/tick/route.ts`.
 *
 * The tick's authorisation check, reclaim-stuck call, claim-next loop,
 * scan execution, and callback fire live here so they can be unit-
 * tested from `tests/scan-worker-tick.test.js` with `node --test`.
 * Nothing in here performs I/O directly — every boundary (sql,
 * scan executor, gluecron callback) is injected.
 *
 * v1 design (per E1):
 *   - Tick runs ONE job per invocation so a 60s Vercel function budget
 *     is never over-committed. The 1-minute cron drains the queue at
 *     ~60 jobs/hour steady state; inline kicks absorb bursts.
 *   - Every call reclaims stuck rows first, so a previous tick that
 *     was killed mid-scan (Vercel cold-stop) can't permanently orphan
 *     a job.
 *   - On success: markDone + callback to Gluecron.
 *   - On failure: markFailed(willRetry = attempts < MAX_ATTEMPTS). If
 *     dead, send an error callback so Gluecron doesn't wait forever.
 *   - Never throws to the caller — callers get { ok, ran?, idle?, error? }.
 */

 
const { MAX_ATTEMPTS } = require('./scan-queue-store');

/**
 * Validate that the request came from the Vercel cron OR from an admin.
 * Returns true if either is satisfied. `CRON_SECRET` is set in Vercel
 * dashboard; the inline kick in /api/events/push forwards the same
 * header value so kicks pass this check too.
 *
 * @param {{ cronHeader: string|null, isAdmin: boolean, env: Record<string, string|undefined> }} args
 */
function isAuthorisedTick({ cronHeader, isAdmin, env }) {
  if (isAdmin) return true;
  const expected = env.CRON_SECRET || '';
  if (!expected) {
    // If CRON_SECRET is not set (local dev, first deploy), accept the
    // request so the cron can fire at all. This matches the pragmatic
    // admin-auth pattern: fail closed only when the system was clearly
    // intended to be closed.
    return true;
  }
  if (!cronHeader || typeof cronHeader !== 'string') return false;
  return cronHeader === expected;
}

/**
 * Orchestrate one worker tick. Reclaims stuck rows, claims one job,
 * runs the scan, writes result + callback.
 *
 * @param {object} args
 * @param {Function} args.sql                             Neon tagged template
 * @param {Object}   args.queueStore                      scan-queue-store module (or test double)
 * @param {Function} args.runScan                         (repoUrl, tier) → Promise<ScanResult>
 * @param {Function} args.sendCallback                    ({ repository, sha, ref, scanResult }) → Promise<any>
 * @param {string}   [args.tier]                          defaults to 'quick'
 */
async function runWorkerTick({
  sql,
  queueStore,
  runScan,
  sendCallback,
  tier = 'quick',
}) {
  if (!sql || typeof sql !== 'function') {
    return { ok: false, error: 'sql tagged-template is required' };
  }
  if (!queueStore || !runScan) {
    return { ok: false, error: 'queueStore and runScan are required' };
  }

  // Reclaim first so an orphaned row can be re-picked immediately.
  let reclaimed = 0;
  try {
    reclaimed = await queueStore.reclaimStuck(sql);
  } catch (err) {
    console.error(
      '[scan-worker] reclaimStuck failed:',
      err && err.message ? err.message : err
    );
  }

  let job;
  try {
    job = await queueStore.claimNextJob(sql);
  } catch (err) {
    return {
      ok: false,
      reclaimed,
      error: err && err.message ? err.message : 'claimNextJob failed',
    };
  }

  if (!job) {
    return { ok: true, idle: true, reclaimed };
  }

  const repository = job.repository;
  const repoUrl = repository && repository.includes('/')
    ? `https://github.com/${repository}`
    : repository;

  // Run the scan. runScan() is expected NEVER to throw; if it does we
  // treat it as a failed attempt.
  let scanResult;
  try {
    scanResult = await runScan(repoUrl, tier);
  } catch (err) {
    scanResult = {
      status: 'failed',
      modules: [],
      totalModules: 0,
      completedModules: 0,
      totalIssues: 0,
      totalFixed: 0,
      duration: 0,
      error: `scan crashed: ${err && err.message ? err.message : err}`,
    };
  }

  const scanFailed =
    !scanResult || scanResult.status !== 'complete' || Boolean(scanResult.error);

  if (!scanFailed) {
    try {
      await queueStore.markDone(job.id, scanResult, sql);
    } catch (err) {
      console.error(
        '[scan-worker] markDone failed:',
        err && err.message ? err.message : err
      );
    }

    // Fire callback with the real result. Never blocks the response
    // beyond a reasonable timeout (the callback helper has its own
    // error swallow).
    try {
      if (sendCallback) {
        await sendCallback({
          repository,
          sha: job.sha,
          ref: job.ref,
          pullRequestNumber: job.pull_request_number,
          host: job.host || 'gluecron',
          scanResult,
        });
      }
    } catch (err) {
      console.error(
        '[scan-worker] sendCallback failed:',
        err && err.message ? err.message : err
      );
    }

    return { ok: true, ran: job.id, reclaimed };
  }

  // Scan failed. Decide whether to retry or dead-letter.
  // job.attempts already reflects THIS attempt (claimNextJob incremented it).
  const willRetry = job.attempts < MAX_ATTEMPTS;
  const errMsg =
    (scanResult && scanResult.error) ||
    `scan returned status=${scanResult && scanResult.status}`;

  try {
    await queueStore.markFailed(job.id, errMsg, willRetry, sql);
  } catch (err) {
    console.error(
      '[scan-worker] markFailed failed:',
      err && err.message ? err.message : err
    );
  }

  // If this was the final attempt, notify Gluecron so it doesn't wait
  // indefinitely. The callback helper marks status='error' when
  // scanResult.error is set.
  if (!willRetry) {
    try {
      if (sendCallback) {
        await sendCallback({
          repository,
          sha: job.sha,
          ref: job.ref,
          pullRequestNumber: job.pull_request_number,
          host: job.host || 'gluecron',
          scanResult,
        });
      }
    } catch (err) {
      console.error(
        '[scan-worker] dead-letter callback failed:',
        err && err.message ? err.message : err
      );
    }
  }

  return {
    ok: false,
    jobId: job.id,
    attempts: job.attempts,
    willRetry,
    reclaimed,
    error: String(errMsg).slice(0, 500),
  };
}

module.exports = {
  isAuthorisedTick,
  runWorkerTick,
};
