'use strict';

/**
 * Crontech dispatch — POSTs a runtime-scan job from GateTest to Crontech.
 *
 * Why this exists:
 *   The /api/web/scan endpoint runs on Vercel-style serverless infra
 *   where Chromium binaries can't reliably launch. The runtime-errors
 *   module needs a real long-running container with Playwright. Crontech
 *   is the worker tier — purpose-built for this kind of work.
 *
 * Contract (Crontech side must implement):
 *   POST {CRONTECH_BASE_URL}/api/jobs/web-runtime-scan
 *     headers:
 *       Authorization: Bearer {CRONTECH_API_TOKEN}
 *       X-GateTest-Signature: hex(hmac-sha256(secret, body))
 *       X-GateTest-Timestamp: unix-seconds
 *     body (JSON):
 *       {
 *         scanId: "scn_xxx",         // links results back to the right scan
 *         targetUrl: "https://...",
 *         suite: "web" | "wp",
 *         callbackUrl: "https://gatetest.ai/api/web/scan/runtime-callback",
 *         deadlineSec: 60
 *       }
 *     response:
 *       201 { jobId: "crontech-job-xyz", queuedAt: "..." }
 *       4xx { error: "..." }
 *
 * Crontech eventually POSTs results back to callbackUrl. See
 * runtime-callback/route.ts for the inbound shape.
 *
 * Failure policy:
 *   - Dispatcher errors are NEVER customer-facing. We log + record the
 *     failure on the scan-queue row and the static-probe results still
 *     ship in the response. Runtime layer is "best effort augmentation."
 *   - If Crontech is down, the customer sees a graceful "runtime checks
 *     unavailable right now" note alongside their static-probe report.
 *
 * Pure module. No I/O at import time. All env reads happen inside the
 * exported functions so tests can mock cleanly.
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 5000;
const SIGNATURE_HEADER = 'X-GateTest-Signature';
const TIMESTAMP_HEADER = 'X-GateTest-Timestamp';

function getEnv(name) {
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
}

/**
 * Hex-encoded HMAC-SHA256 of the raw body using the dispatch secret.
 * Crontech verifies this on receipt; if absent or invalid, Crontech
 * must reject the job (fail-closed, Bible Forbidden #15).
 *
 * @param {string} body - the raw JSON string we POST
 * @param {string} secret - shared HMAC secret
 * @returns {string} hex digest
 */
function signBody(body, secret) {
  if (typeof body !== 'string') throw new TypeError('signBody: body must be a string');
  if (typeof secret !== 'string' || !secret) throw new Error('signBody: secret is required');
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Verify an inbound signature from Crontech using constant-time compare.
 * Returns true only when both digests are present + equal length + match.
 *
 * @param {string} body
 * @param {string|null|undefined} providedSignature
 * @param {string} secret
 * @returns {boolean}
 */
function verifySignature(body, providedSignature, secret) {
  if (typeof body !== 'string') return false;
  if (typeof providedSignature !== 'string' || !providedSignature) return false;
  if (typeof secret !== 'string' || !secret) return false;
  const expected = signBody(body, secret);
  if (expected.length !== providedSignature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSignature));
  } catch {
    return false;
  }
}

/**
 * Build the dispatch payload. Pure helper — exposed for tests.
 *
 * @param {Object} opts
 * @param {string} opts.scanId
 * @param {string} opts.targetUrl
 * @param {string} opts.suite      'web' | 'wp'
 * @param {string} opts.callbackUrl
 * @param {number} [opts.deadlineSec]
 * @returns {{scanId:string, targetUrl:string, suite:string, callbackUrl:string, deadlineSec:number}}
 */
function buildDispatchPayload({ scanId, targetUrl, suite, callbackUrl, deadlineSec = 60 }) {
  if (!scanId) throw new Error('buildDispatchPayload: scanId is required');
  if (!targetUrl) throw new Error('buildDispatchPayload: targetUrl is required');
  if (!suite) throw new Error('buildDispatchPayload: suite is required');
  if (!callbackUrl) throw new Error('buildDispatchPayload: callbackUrl is required');
  return {
    scanId: String(scanId),
    targetUrl: String(targetUrl),
    suite: String(suite),
    callbackUrl: String(callbackUrl),
    deadlineSec: Math.max(10, Math.min(300, Number(deadlineSec) || 60)),
  };
}

/**
 * Dispatch a runtime-scan job to Crontech.
 *
 * Never throws. Always returns a shape with `ok: boolean` and either
 * `jobId` (success) or `reason` (failure). The route handler that
 * called us records the failure and continues — static-probe results
 * still ship.
 *
 * @param {Object} opts
 * @param {string} opts.scanId
 * @param {string} opts.targetUrl
 * @param {string} opts.suite
 * @param {string} opts.callbackUrl
 * @param {number} [opts.deadlineSec]
 * @param {Object} [opts.deps] - injection point for tests
 * @param {string} [opts.deps.baseUrl]
 * @param {string} [opts.deps.apiToken]
 * @param {string} [opts.deps.dispatchSecret]
 * @param {Function} [opts.deps.fetchFn]  - override global fetch (tests)
 * @param {number} [opts.deps.timeoutMs]
 * @returns {Promise<{ok: true, jobId: string, queuedAt: string} | {ok: false, reason: string, status?: number}>}
 */
async function dispatchRuntimeScan(opts) {
  const deps = (opts && opts.deps) || {};
  const baseUrl = deps.baseUrl || getEnv('CRONTECH_BASE_URL');
  const apiToken = deps.apiToken || getEnv('CRONTECH_API_TOKEN');
  const dispatchSecret = deps.dispatchSecret || getEnv('CRONTECH_DISPATCH_SECRET');
  const fetchFn = deps.fetchFn || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = typeof deps.timeoutMs === 'number' ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (!baseUrl) return { ok: false, reason: 'CRONTECH_BASE_URL not configured' };
  if (!apiToken) return { ok: false, reason: 'CRONTECH_API_TOKEN not configured' };
  if (!dispatchSecret) return { ok: false, reason: 'CRONTECH_DISPATCH_SECRET not configured' };
  if (!fetchFn) return { ok: false, reason: 'fetch unavailable in this runtime' };

  let payload;
  try {
    payload = buildDispatchPayload(opts);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signBody(body, dispatchSecret);

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/jobs/web-runtime-scan`;
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: timestamp,
      },
      body,
      signal: controller ? controller.signal : undefined,
    });

    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch { /* ignore */ }
      return { ok: false, status: resp.status, reason: `Crontech rejected dispatch: ${resp.status} ${detail}` };
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, status: resp.status, reason: 'Crontech returned non-JSON response' };
    }
    if (!data || typeof data.jobId !== 'string') {
      return { ok: false, status: resp.status, reason: 'Crontech response missing jobId' };
    }
    return { ok: true, jobId: data.jobId, queuedAt: data.queuedAt || new Date().toISOString() };
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `Dispatch timed out after ${timeoutMs}ms`
      : (err && err.message) || 'Unknown dispatch error';
    return { ok: false, reason };
  } finally {
    if (t) clearTimeout(t);
  }
}

module.exports = {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DEFAULT_TIMEOUT_MS,
  signBody,
  verifySignature,
  buildDispatchPayload,
  dispatchRuntimeScan,
};
