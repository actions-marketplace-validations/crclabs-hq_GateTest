/**
 * Pure helpers for the Signal Bus E1 inbound endpoint at
 * `website/app/api/events/push/route.ts`.
 *
 * The route's HMAC verification, body parsing, shape validation, and
 * enqueue flow live here so they can be unit-tested from
 * `tests/events-push.test.js` with `node --test`. Nothing in here
 * performs network I/O. `processPushEvent` accepts injected `sql`
 * (Neon tagged-template) and `fetchImpl` seams so tests mock at the
 * right boundary.
 *
 * Wire contract — DO NOT import from Gluecron; each repo keeps its own
 * copy per the HTTP-only coupling rule. Source: Gluecron.com/GATETEST_HOOK.md.
 *
 * POST /api/events/push
 * Headers:
 *   X-Signal-Signature: sha256=<hmac(GLUECRON_EMITTER_SECRET, rawBody)>
 * Body (JSON):
 *   { eventId, eventType:'push.received', repository, sha, ref,
 *     pullRequestNumber, emittedAt }
 *
 * Responses:
 *   202 { queued: true, eventId }       — new event enqueued
 *   200 { duplicate: true, eventId }    — idempotency hit
 *   400 { error: 'malformed' }          — body / shape invalid
 *   401 { error: 'invalid signature' }  — HMAC mismatch
 *   429 { error: 'queue full' }         — depth >= 500, Retry-After: 30
 *   503 { error: 'secret not set' }     — env misconfigured
 */

 
const crypto = require('crypto');

// Backpressure threshold. Above this queue depth we 429.
const QUEUE_FULL_THRESHOLD = 500;
const RETRY_AFTER_SECONDS = 30;

/**
 * Timing-safe compare of two equal-length strings. Returns false on
 * length mismatch or missing inputs — never throws.
 */
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
 * Verify the X-Signal-Signature header against the raw body using
 * HMAC-SHA256 keyed on the emitter secret. Returns boolean.
 *
 * @param {string} rawBody
 * @param {string|null} headerValue  e.g. 'sha256=abcdef...'
 * @param {string} secret
 */
function verifySignalSignature(rawBody, headerValue, secret) {
  if (!secret) return false;
  if (!headerValue || typeof headerValue !== 'string') return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, headerValue);
}

/**
 * Validate the parsed JSON body against the Signal Bus E1 contract.
 * Returns `{ ok: true, payload }` or `{ ok: false, error }`.
 *
 * @param {unknown} parsed
 */
function validatePushPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const p = /** @type {Record<string, unknown>} */ (parsed);

  if (typeof p.eventId !== 'string' || !p.eventId) {
    return { ok: false, error: 'eventId is required' };
  }
  if (p.eventType !== 'push.received') {
    return { ok: false, error: "eventType must be 'push.received'" };
  }
  if (typeof p.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(p.repository)) {
    return { ok: false, error: "repository must be 'owner/name'" };
  }
  if (typeof p.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(p.sha)) {
    return { ok: false, error: 'sha must be a 40-hex string' };
  }
  if (typeof p.ref !== 'string' || !p.ref) {
    return { ok: false, error: 'ref is required' };
  }
  if (typeof p.emittedAt !== 'string' || !p.emittedAt) {
    return { ok: false, error: 'emittedAt is required' };
  }

  let prNum = null;
  if (p.pullRequestNumber !== null && p.pullRequestNumber !== undefined) {
    const n = Number(p.pullRequestNumber);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'pullRequestNumber must be an integer or null' };
    }
    prNum = n;
  }

  return {
    ok: true,
    payload: {
      eventId: p.eventId,
      eventType: p.eventType,
      repository: p.repository,
      sha: p.sha,
      ref: p.ref,
      pullRequestNumber: prNum,
      emittedAt: p.emittedAt,
    },
  };
}

/**
 * End-to-end handler for a POST /api/events/push request. Returns a
 * plain `{ status, body, headers? }` object so the route can translate
 * to a NextResponse without knowing the orchestration details.
 *
 * @param {object} args
 * @param {string} args.rawBody
 * @param {string|null} args.signatureHeader
 * @param {Record<string, string | undefined>} args.env
 * @param {Function} args.sql                                 Neon tagged template
 * @param {Object} args.queueStore                            scan-queue-store module (or test double)
 * @param {(url:string, init:object)=>Promise<unknown>} [args.fetchImpl]  for the async kick
 * @param {string} [args.baseUrl]                             for the async kick URL
 */
async function processPushEvent({
  rawBody,
  signatureHeader,
  env,
  sql,
  queueStore,
  fetchImpl,
  baseUrl,
}) {
  const secret = env.GLUECRON_EMITTER_SECRET;
  if (!secret) {
    return {
      status: 503,
      body: { error: 'GLUECRON_EMITTER_SECRET is not set' },
    };
  }

  if (!verifySignalSignature(rawBody, signatureHeader, secret)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'malformed: invalid JSON' } };
  }

  const validation = validatePushPayload(parsed);
  if (!validation.ok) {
    return { status: 400, body: { error: `malformed: ${validation.error}` } };
  }
  const payload = validation.payload;

  // Backpressure — don't let the queue balloon past THRESHOLD.
  let depth = 0;
  try {
    depth = await queueStore.getQueueDepth(sql);
  } catch (err) { // error-ok — queue depth check fails open; still enqueue rather than drop the event
    console.error('[events-push] getQueueDepth failed:', err && err.message ? err.message : err);
    // Fail open — if we can't read depth, still try to enqueue.
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
      host: 'gluecron',
      sql,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'enqueue failed';
    console.error('[events-push] enqueueScan failed:', msg);
    return { status: 500, body: { error: msg } };
  }

  // Fire-and-forget kick to the worker so a push during a cron gap still
  // runs promptly. No await — caller gets a fast 202. Failure is logged
  // and discarded; the 1-minute cron will pick the row up anyway.
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
            '[events-push] worker kick failed:',
            err && err.message ? err.message : err
          );
        });
      }
    } catch (err) {
      console.error(
        '[events-push] worker kick threw:',
        err && err.message ? err.message : err
      );
    }
  }

  if (enq.duplicate) {
    return {
      status: 200,
      body: { duplicate: true, eventId: payload.eventId },
    };
  }
  return {
    status: 202,
    body: { queued: true, eventId: payload.eventId },
  };
}

module.exports = {
  QUEUE_FULL_THRESHOLD,
  RETRY_AFTER_SECONDS,
  verifySignalSignature,
  validatePushPayload,
  processPushEvent,
};
