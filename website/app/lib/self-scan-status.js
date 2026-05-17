/**
 * Pure helpers + module-level store for the live self-scan badge.
 *
 * The route at `website/app/api/internal/self-scan-status/route.ts`
 * delegates to these helpers so the wire contract (HMAC, payload
 * shape, fail-closed behaviour) can be unit-tested from
 * `tests/self-scan-status-api.test.js` with `node --test` and no
 * network I/O.
 *
 * STORAGE STRATEGY — read this carefully.
 *
 * The latest self-scan result is held in a module-level variable
 * `_latest` plus a bounded ring buffer `_history` (max 30 entries).
 * Vercel serverless functions have one important caveat: module-level
 * state survives WITHIN a single warm function instance but NOT across
 * cold-start boundaries between instances. For this badge that's
 * acceptable because:
 *
 *   (a) the badge is a TRUST signal, not user-facing state — a brief
 *       cold-start "no-data" placeholder is honest, not a bug;
 *   (b) the CI self-scan job POSTs every run, so any cold instance
 *       warms up the next time CI runs (every PR + every push to main);
 *   (c) the badge component polls every 60s, so a freshly warmed
 *       instance with no data is replaced by a populated state within
 *       a minute of the next CI run;
 *   (d) we deliberately do NOT block on Postgres availability here —
 *       the publish step in CI is best-effort (fail-closed for security,
 *       fail-open for availability of the publish itself).
 *
 * Bible compliance: this is an OPT-IN exception to "no in-memory state
 * on Vercel serverless" — Craig has authorised this for the badge use
 * case specifically. NEVER copy this pattern for billing, scan results,
 * or any state that affects a user's wallet or data.
 *
 * Wire contract:
 *   POST /api/internal/self-scan-status
 *   Headers:
 *     X-Internal-Signature: sha256=<hmac(GATETEST_INTERNAL_TOKEN, rawBody)>
 *     Content-Type: application/json
 *   Body (JSON):
 *     {
 *       gateStatus: "PASSED" | "BLOCKED",
 *       errorCount: number,
 *       warningCount: number,
 *       modulesPassedCount: number,
 *       modulesTotalCount: number,
 *       scannedAt: string (ISO-8601),
 *       commitSha: string (7-40 hex chars)
 *     }
 *
 * Responses:
 *   200 { stored: true }                      — accepted
 *   400 { error: 'malformed' }                — body shape invalid
 *   401 { error: 'missing signature' }        — no header / no secret
 *   403 { error: 'invalid signature' }        — HMAC mismatch
 *   503 { error: 'secret not set' }           — env misconfigured (fail-closed)
 *
 *   GET  /api/internal/self-scan-status
 *     200 { gateStatus, errorCount, warningCount, modulesPassedCount,
 *           modulesTotalCount, scannedAt, commitSha, ageMinutes }
 *   OR
 *     200 { status: 'no-data', message: 'Awaiting first self-scan on the main branch' }
 */

const crypto = require('crypto');

const HISTORY_LIMIT = 30;

/**
 * Module-level mutable state. See storage strategy note above.
 * @type {null | StoredStats}
 */
let _latest = null;

/** @type {Array<StoredStats>} */
let _history = [];

/**
 * @typedef {Object} StoredStats
 * @property {'PASSED'|'BLOCKED'} gateStatus
 * @property {number} errorCount
 * @property {number} warningCount
 * @property {number} modulesPassedCount
 * @property {number} modulesTotalCount
 * @property {string} scannedAt        ISO-8601 timestamp
 * @property {string} commitSha        7-40 hex chars
 * @property {number} receivedAt       epoch ms — when WE accepted the publish
 */

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
 * Verify the X-Internal-Signature header against the raw body using
 * HMAC-SHA256 keyed on the internal token.
 *
 * @param {string} rawBody
 * @param {string|null|undefined} headerValue  e.g. 'sha256=abcdef...'
 * @param {string} secret
 */
function verifyInternalSignature(rawBody, headerValue, secret) {
  if (!secret) return false;
  if (!headerValue || typeof headerValue !== 'string') return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, headerValue);
}

/**
 * Compute the canonical signature header for a body. Used by the
 * CI publish step (called from `scripts/publish-self-scan.js`) and
 * by tests.
 *
 * @param {string} rawBody
 * @param {string} secret
 * @returns {string} 'sha256=<hex>'
 */
function signBody(rawBody, secret) {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  );
}

/**
 * Validate the parsed JSON body against the self-scan-status contract.
 * Returns `{ ok: true, payload }` or `{ ok: false, error }`.
 *
 * @param {unknown} parsed
 */
function validateStatusPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const p = /** @type {Record<string, unknown>} */ (parsed);

  if (p.gateStatus !== 'PASSED' && p.gateStatus !== 'BLOCKED') {
    return { ok: false, error: "gateStatus must be 'PASSED' or 'BLOCKED'" };
  }
  if (!Number.isFinite(p.errorCount) || /** @type {number} */ (p.errorCount) < 0) {
    return { ok: false, error: 'errorCount must be a non-negative number' };
  }
  if (!Number.isFinite(p.warningCount) || /** @type {number} */ (p.warningCount) < 0) {
    return { ok: false, error: 'warningCount must be a non-negative number' };
  }
  if (
    !Number.isFinite(p.modulesPassedCount) ||
    /** @type {number} */ (p.modulesPassedCount) < 0
  ) {
    return {
      ok: false,
      error: 'modulesPassedCount must be a non-negative number',
    };
  }
  if (
    !Number.isFinite(p.modulesTotalCount) ||
    /** @type {number} */ (p.modulesTotalCount) <= 0
  ) {
    return {
      ok: false,
      error: 'modulesTotalCount must be a positive number',
    };
  }
  if (
    /** @type {number} */ (p.modulesPassedCount) >
    /** @type {number} */ (p.modulesTotalCount)
  ) {
    return {
      ok: false,
      error: 'modulesPassedCount cannot exceed modulesTotalCount',
    };
  }
  if (typeof p.scannedAt !== 'string' || !p.scannedAt) {
    return { ok: false, error: 'scannedAt is required (ISO-8601 string)' };
  }
  if (Number.isNaN(Date.parse(/** @type {string} */ (p.scannedAt)))) {
    return { ok: false, error: 'scannedAt must be a parseable date string' };
  }
  if (typeof p.commitSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(p.commitSha)) {
    return { ok: false, error: 'commitSha must be 7-40 hex characters' };
  }

  return {
    ok: true,
    payload: {
      gateStatus: /** @type {'PASSED'|'BLOCKED'} */ (p.gateStatus),
      errorCount: /** @type {number} */ (p.errorCount),
      warningCount: /** @type {number} */ (p.warningCount),
      modulesPassedCount: /** @type {number} */ (p.modulesPassedCount),
      modulesTotalCount: /** @type {number} */ (p.modulesTotalCount),
      scannedAt: /** @type {string} */ (p.scannedAt),
      commitSha: /** @type {string} */ (p.commitSha).toLowerCase(),
    },
  };
}

/**
 * Process a self-scan-status POST. Returns a status + body to render.
 * Pure: takes injected env so tests don't have to mutate process.env.
 *
 * @param {Object} args
 * @param {string} args.rawBody
 * @param {string|null|undefined} args.signatureHeader
 * @param {Record<string,string|undefined>} args.env  e.g. process.env
 * @param {number} [args.nowMs]                       for testing
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
function processPublishStatus({ rawBody, signatureHeader, env, nowMs }) {
  const secret = env.GATETEST_INTERNAL_TOKEN || '';

  // Forbidden #15 — fail closed on missing secret.
  if (!secret) {
    return { status: 503, body: { error: 'secret not set' } };
  }
  // No signature header at all — 401 (vs. 403 for wrong signature).
  if (!signatureHeader) {
    return { status: 401, body: { error: 'missing signature' } };
  }
  if (!verifyInternalSignature(rawBody, signatureHeader, secret)) {
    return { status: 403, body: { error: 'invalid signature' } };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'malformed: invalid JSON' } };
  }

  const validation = validateStatusPayload(parsed);
  if (!validation.ok) {
    return { status: 400, body: { error: `malformed: ${validation.error}` } };
  }

  const receivedAt = typeof nowMs === 'number' ? nowMs : Date.now();
  /** @type {StoredStats} */
  const stored = { ...validation.payload, receivedAt };

  _latest = stored;
  _history.unshift(stored);
  if (_history.length > HISTORY_LIMIT) {
    _history = _history.slice(0, HISTORY_LIMIT);
  }

  return { status: 200, body: { stored: true, commitSha: stored.commitSha } };
}

/**
 * Get the latest self-scan stats for the GET handler. Returns either
 * a populated stats shape or the `no-data` placeholder.
 *
 * @param {number} [nowMs]   for testing
 */
function getLatestStatus(nowMs) {
  if (!_latest) {
    return {
      status: 'no-data',
      message: 'Awaiting first self-scan on the main branch',
    };
  }
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const ageMs = Math.max(0, now - _latest.receivedAt);
  const ageMinutes = Math.floor(ageMs / 60000);
  return {
    gateStatus: _latest.gateStatus,
    errorCount: _latest.errorCount,
    warningCount: _latest.warningCount,
    modulesPassedCount: _latest.modulesPassedCount,
    modulesTotalCount: _latest.modulesTotalCount,
    scannedAt: _latest.scannedAt,
    commitSha: _latest.commitSha,
    ageMinutes,
  };
}

/**
 * Get the bounded history. Returns most-recent-first. Used by the
 * `/api/internal/self-scan-history` endpoint and any future trend chart.
 */
function getHistory() {
  return _history.map((entry) => ({
    gateStatus: entry.gateStatus,
    errorCount: entry.errorCount,
    warningCount: entry.warningCount,
    modulesPassedCount: entry.modulesPassedCount,
    modulesTotalCount: entry.modulesTotalCount,
    scannedAt: entry.scannedAt,
    commitSha: entry.commitSha,
  }));
}

/**
 * Reset module-level state. EXPORTED FOR TESTS ONLY — never call from
 * production code paths.
 */
function _resetForTests() {
  _latest = null;
  _history = [];
}

/**
 * Pure derivation: turn a SelfScanStatusData (or null / fetch error)
 * into the three semantic UI states the badge renders. Lives here so
 * the badge component's rendering logic is unit-testable.
 *
 * @param {unknown} data            — value returned by the API, or null
 * @param {boolean} [fetchError]    — true if the fetch itself failed
 * @returns {{
 *   variant: 'passed'|'blocked'|'awaiting',
 *   labelText: string,
 *   metricLine: string|null,
 *   commitShaShort: string|null,
 *   ariaLabel: string,
 * }}
 */
function deriveBadgeState(data, fetchError) {
  const isAwaiting =
    Boolean(fetchError) ||
    !data ||
    (typeof data === 'object' &&
      data !== null &&
      'status' in data &&
      /** @type {Record<string, unknown>} */ (data).status === 'no-data');

  if (isAwaiting) {
    let message = 'Awaiting first scan';
    if (
      data &&
      typeof data === 'object' &&
      'message' in data &&
      typeof /** @type {Record<string, unknown>} */ (data).message === 'string'
    ) {
      // not used as primary label but available
    }
    return {
      variant: 'awaiting',
      labelText: 'Awaiting first scan',
      metricLine: null,
      commitShaShort: null,
      ariaLabel: 'Self-scan status: awaiting first scan',
      _message: message,
    };
  }

  const d = /** @type {Record<string, unknown>} */ (data);
  const variant = d.gateStatus === 'PASSED' ? 'passed' : 'blocked';
  const labelText = variant === 'passed' ? 'GREEN' : 'BLOCKED';

  const minutes = Number(d.ageMinutes);
  const ageText = _formatAge(Number.isFinite(minutes) ? minutes : 0);
  const sha = typeof d.commitSha === 'string' ? d.commitSha : '';

  const metricLine =
    `${d.modulesPassedCount}/${d.modulesTotalCount} modules · ` +
    `${d.errorCount} errors · ${d.warningCount} warnings · ${ageText}`;

  return {
    variant,
    labelText,
    metricLine,
    commitShaShort: sha ? (sha.length > 7 ? sha.slice(0, 7) : sha) : null,
    ariaLabel: `Self-scan status: ${labelText}. ${metricLine}`,
  };
}

function _formatAge(minutes) {
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hr ago';
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

module.exports = {
  HISTORY_LIMIT,
  verifyInternalSignature,
  signBody,
  validateStatusPayload,
  processPublishStatus,
  getLatestStatus,
  getHistory,
  deriveBadgeState,
  _resetForTests,
};
