/**
 * Pure helpers for the GitHub webhook endpoint at
 * `website/app/api/webhook/route.ts`.
 *
 * GateTest is dual-host: push / PR events can arrive from Gluecron (via
 * the Signal Bus at /api/events/push) OR directly from a GitHub App
 * webhook (this path). Once an event is in the shared `scan_queue`,
 * downstream scan execution is host-agnostic — `gluecron-client.ts`
 * resolves `owner/repo` through the Gluecron API when a `GLUECRON_*`
 * token is set, and falls back to the GitHub REST API when a GitHub PAT
 * (ghp_… / gho_… / GITHUB_TOKEN / GATETEST_GITHUB_TOKEN) is configured.
 *
 * This module contains NO network I/O so it can be unit-tested against
 * `node --test` from `tests/github-events.test.js`. The route handler
 * supplies the sql tagged template and the queue store.
 *
 * Wire contract (GitHub App → us):
 *   POST /api/webhook
 *   Headers:
 *     X-GitHub-Event: push | pull_request | ping | ...
 *     X-GitHub-Delivery: <uuid>        (idempotency key)
 *     X-Hub-Signature-256: sha256=<hmac(GITHUB_WEBHOOK_SECRET, rawBody)>
 *     Content-Type: application/json
 *
 * Event handling:
 *   - push: enqueue scan for `repository.full_name` @ `after` on `ref`
 *   - pull_request (opened|synchronize|reopened): enqueue for
 *     `repository.full_name` @ `pull_request.head.sha` on
 *     `pull_request.head.ref`, with PR number recorded
 *   - ping: 200 OK (no enqueue — GitHub sends on hook registration)
 *   - anything else: 204 No Content (acknowledge + drop)
 *
 * Security:
 *   - `GITHUB_WEBHOOK_SECRET` missing → 503 (fail closed, Forbidden #15)
 *   - Invalid signature → 401
 *   - Malformed body → 400
 */

 
const crypto = require('crypto');

const QUEUE_FULL_THRESHOLD = 500;
const RETRY_AFTER_SECONDS = 30;

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verify GitHub's X-Hub-Signature-256 header.
 * Format: `sha256=<hex-hmac-of-raw-body-keyed-with-secret>`.
 *
 * @param {string} rawBody
 * @param {string|null} headerValue
 * @param {string} secret
 */
function verifyGitHubSignature(rawBody, headerValue, secret) {
  if (!secret) return false;
  if (!headerValue || typeof headerValue !== 'string') return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, headerValue);
}

/**
 * Translate a GitHub webhook payload into the canonical scan-queue shape.
 * Returns one of:
 *   { kind: 'enqueue', payload: { eventId, repository, sha, ref, pullRequestNumber } }
 *   { kind: 'ping' }        — acknowledge without enqueue
 *   { kind: 'ignore', reason } — non-actionable event; 204
 *   { kind: 'error', reason } — malformed payload; 400
 *
 * @param {string|null} eventType   X-GitHub-Event value
 * @param {string|null} delivery    X-GitHub-Delivery value (UUID)
 * @param {unknown} parsed           JSON.parse(rawBody)
 */
function extractGitHubEvent(eventType, delivery, parsed) {
  if (eventType === 'ping') return { kind: 'ping' };

  if (!delivery || typeof delivery !== 'string') {
    return { kind: 'error', reason: 'missing X-GitHub-Delivery header' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'error', reason: 'body must be a JSON object' };
  }
  const p = /** @type {Record<string, unknown>} */ (parsed);

  const repo =
    p.repository && typeof p.repository === 'object'
      ? /** @type {Record<string, unknown>} */ (p.repository)
      : null;
  const fullName = repo && typeof repo.full_name === 'string' ? repo.full_name : null;
  if (!fullName || !/^[^/]+\/[^/]+$/.test(fullName)) {
    return { kind: 'error', reason: 'repository.full_name is required' };
  }

  if (eventType === 'push') {
    const sha = typeof p.after === 'string' ? p.after : null;
    const ref = typeof p.ref === 'string' ? p.ref : null;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
      return { kind: 'error', reason: 'push.after must be a 40-hex sha' };
    }
    if (!ref) {
      return { kind: 'error', reason: 'push.ref is required' };
    }
    // Ignore deletion pushes (sha = 40 zeros)
    if (/^0{40}$/.test(sha)) {
      return { kind: 'ignore', reason: 'branch delete push (all-zero sha)' };
    }
    return {
      kind: 'enqueue',
      payload: {
        eventId: delivery,
        repository: fullName,
        sha,
        ref,
        pullRequestNumber: null,
      },
    };
  }

  if (eventType === 'pull_request') {
    const action = typeof p.action === 'string' ? p.action : '';
    const actionable = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
    if (!actionable.has(action)) {
      return { kind: 'ignore', reason: `pull_request action=${action || '<none>'}` };
    }
    const pr =
      p.pull_request && typeof p.pull_request === 'object'
        ? /** @type {Record<string, unknown>} */ (p.pull_request)
        : null;
    if (!pr) {
      return { kind: 'error', reason: 'pull_request object is required' };
    }
    const head =
      pr.head && typeof pr.head === 'object'
        ? /** @type {Record<string, unknown>} */ (pr.head)
        : null;
    const sha = head && typeof head.sha === 'string' ? head.sha : null;
    const refName = head && typeof head.ref === 'string' ? head.ref : null;
    const ref = refName ? `refs/heads/${refName}` : null;
    const number = typeof pr.number === 'number' ? pr.number : null;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
      return { kind: 'error', reason: 'pull_request.head.sha must be a 40-hex sha' };
    }
    if (!ref) {
      return { kind: 'error', reason: 'pull_request.head.ref is required' };
    }
    if (number === null) {
      return { kind: 'error', reason: 'pull_request.number is required' };
    }
    return {
      kind: 'enqueue',
      payload: {
        eventId: delivery,
        repository: fullName,
        sha,
        ref,
        pullRequestNumber: number,
      },
    };
  }

  return { kind: 'ignore', reason: `unhandled event=${eventType || '<none>'}` };
}

/**
 * End-to-end handler for a POST /api/webhook request. Returns
 * `{ status, body, headers? }` so the route file stays thin.
 *
 * @param {object} args
 * @param {string} args.rawBody
 * @param {string|null} args.eventType
 * @param {string|null} args.delivery
 * @param {string|null} args.signatureHeader
 * @param {Record<string, string | undefined>} args.env
 * @param {Function} args.sql
 * @param {Object} args.queueStore
 * @param {(url:string, init:object)=>Promise<unknown>} [args.fetchImpl]
 * @param {string} [args.baseUrl]
 */
async function processGitHubEvent({
  rawBody,
  eventType,
  delivery,
  signatureHeader,
  env,
  sql,
  queueStore,
  fetchImpl,
  baseUrl,
}) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return {
      status: 503,
      body: { error: 'GITHUB_WEBHOOK_SECRET is not set' },
    };
  }
  if (!verifyGitHubSignature(rawBody, signatureHeader, secret)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'malformed: invalid JSON' } };
  }

  const extracted = extractGitHubEvent(eventType, delivery, parsed);
  if (extracted.kind === 'ping') {
    return { status: 200, body: { ok: true, pong: true } };
  }
  if (extracted.kind === 'error') {
    return { status: 400, body: { error: `malformed: ${extracted.reason}` } };
  }
  if (extracted.kind === 'ignore') {
    return { status: 204, body: null };
  }

  const payload = extracted.payload;

  // Backpressure — mirror the Signal Bus path so a spike doesn't blow the queue.
  let depth = 0;
  try {
    depth = await queueStore.getQueueDepth(sql);
  } catch (err) { // error-ok — queue depth check fails open; still enqueue rather than drop the event
    console.error('[github-webhook] getQueueDepth failed:', err && err.message ? err.message : err);
  }
  if (depth >= QUEUE_FULL_THRESHOLD) {
    return {
      status: 429,
      body: { error: 'queue full', depth },
      headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
    };
  }

  let enq;
  try {
    enq = await queueStore.enqueueScan({
      eventId: payload.eventId,
      repository: payload.repository,
      sha: payload.sha,
      ref: payload.ref,
      pullRequestNumber: payload.pullRequestNumber,
      host: 'github',
      sql,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'enqueue failed';
    console.error('[github-webhook] enqueueScan failed:', msg);
    return { status: 500, body: { error: msg } };
  }

  if (!enq.duplicate && fetchImpl && baseUrl) {
    try {
      const url = `${baseUrl}/api/scan/worker/tick`;
      const p = fetchImpl(url, {
        method: 'POST',
        headers: {
          'X-Vercel-Cron-Secret': env.CRON_SECRET || '',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.error(
            '[github-webhook] worker kick failed:',
            err && err.message ? err.message : err
          );
        });
      }
    } catch (err) {
      console.error(
        '[github-webhook] worker kick threw:',
        err && err.message ? err.message : err
      );
    }
  }

  if (enq.duplicate) {
    return { status: 200, body: { duplicate: true, eventId: payload.eventId } };
  }
  return { status: 202, body: { queued: true, eventId: payload.eventId } };
}

module.exports = {
  QUEUE_FULL_THRESHOLD,
  RETRY_AFTER_SECONDS,
  verifyGitHubSignature,
  extractGitHubEvent,
  processGitHubEvent,
};
