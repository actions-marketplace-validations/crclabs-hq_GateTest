/**
 * Remote recipe-store adapter — HTTP-backed pluggable persistence for the
 * fix-recipe flywheel.
 *
 * GitHub Actions runners are ephemeral; the local JSON recipe store gets
 * wiped every run. To make the flywheel actually learn across runs, we
 * sync recipes to a customer-provided HTTP endpoint:
 *
 *   GET  ${GATETEST_RECIPE_STORE_URL}     → returns { recipes: [...] }
 *   PUT  ${GATETEST_RECIPE_STORE_URL}     → upserts a single recipe (body)
 *
 * Auth: if `GATETEST_RECIPE_STORE_TOKEN` is set, attached as
 *   Authorization: Bearer <token>
 *
 * Design rules:
 *   - ZERO npm deps (built-in `node:https` + `node:http` + `node:url`).
 *   - 10s timeout per call (bounded).
 *   - On ANY error: log to stderr and return null. NEVER throw — the recipe
 *     store is best-effort.
 *   - `transport` can be injected (test override).
 *
 * This module complements `auto-distill.js` rather than replacing it:
 *   - `auto-distill` owns the LOCAL JSON store.
 *   - `recipe-store-remote` owns the OPTIONAL HTTP store.
 *   - `auto-distill.findMatchingRecipe` is wired to consult remote FIRST
 *     (when configured) and local as a fallback. Writes go to BOTH.
 */

'use strict';

const https = require('node:https');
const http  = require('node:http');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 10_000;
const ENV_URL_KEY   = 'GATETEST_RECIPE_STORE_URL';
const ENV_TOKEN_KEY = 'GATETEST_RECIPE_STORE_TOKEN';

// ---------------------------------------------------------------------------
// stderr-only logging — never pollutes stdout
// ---------------------------------------------------------------------------

function logErr(msg, err) {
  const detail = err && err.message ? `: ${err.message}` : '';
  try {
    process.stderr.write(`[recipe-store-remote] ${msg}${detail}\n`);
  } catch {
    /* never throw out of a log helper */
  }
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

/**
 * Is the remote store configured via env? Cheap check used by callers to
 * decide whether to spend an HTTP round-trip.
 */
function isRemoteConfigured(env = process.env) {
  return Boolean(env && typeof env[ENV_URL_KEY] === 'string' && env[ENV_URL_KEY].trim() !== '');
}

function readEnvConfig(env = process.env) {
  if (!env) return null;
  const url = env[ENV_URL_KEY];
  if (!url || typeof url !== 'string' || url.trim() === '') return null;
  const token = env[ENV_TOKEN_KEY];
  return {
    url: url.trim(),
    token: token && typeof token === 'string' && token.trim() !== '' ? token.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function pickTransport(parsedUrl, override) {
  if (override) return override;
  return parsedUrl.protocol === 'http:' ? http : https;
}

/**
 * Issue a single HTTP request. Returns a Promise that ALWAYS resolves to
 * `{ status, body, raw, headers }` on completion, or `null` on error / timeout.
 *
 * @param {object} opts
 * @param {string} opts.url         — full URL
 * @param {string} opts.method      — GET | PUT | PATCH | POST
 * @param {object|string|null} [opts.body]
 * @param {string|null} [opts.token]
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.transport] — override (`https`/`http`-shaped)
 */
function httpRequest({ url, method, body = null, token = null, timeoutMs = DEFAULT_TIMEOUT_MS, transport: transportOverride }) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      logErr(`invalid url ${url}`, err);
      resolve(null);
      return;
    }

    const dataString = body == null
      ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));

    const headers = {
      'Accept':       'application/json',
      'User-Agent':   'gatetest-recipe-store',
    };
    if (dataString != null) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(dataString);
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const reqOpts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path:     `${parsed.pathname}${parsed.search || ''}`,
      method,
      headers,
    };

    const transport = pickTransport(parsed, transportOverride);

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req;
    try {
      req = transport.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf-8');
          let parsedBody = null;
          if (raw) {
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              parsedBody = null;
            }
          }
          settle({ status: res.statusCode, body: parsedBody, raw, headers: res.headers || {} });
        });
        res.on('error', (err) => {
          logErr(`response error on ${method} ${url}`, err);
          settle(null);
        });
      });
    } catch (err) {
      logErr(`request setup failed for ${method} ${url}`, err);
      settle(null);
      return;
    }

    req.on('error', (err) => {
      logErr(`network error on ${method} ${url}`, err);
      settle(null);
    });

    // Timeout — destroy the request and resolve null.
    const timer = setTimeout(() => {
      try { req.destroy(new Error(`recipe-store request timeout after ${timeoutMs}ms`)); } catch { /* ignore */ }
      logErr(`timeout on ${method} ${url} after ${timeoutMs}ms`);
      settle(null);
    }, timeoutMs);

    req.on('close', () => clearTimeout(timer));

    if (dataString != null) {
      try { req.write(dataString); } catch (err) { logErr('req.write failed', err); }
    }
    try { req.end(); } catch (err) { logErr('req.end failed', err); }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * GET the remote store. Returns `{ recipes: [...] }` on 200/2xx with parseable
 * JSON; returns `null` on any failure (network error, non-2xx, malformed JSON,
 * missing URL).
 *
 * @param {string} [url]    — defaults to env GATETEST_RECIPE_STORE_URL
 * @param {object} [opts]
 * @param {string} [opts.token]      — auth token (defaults to env)
 * @param {number} [opts.timeoutMs]  — default 10_000
 * @param {object} [opts.transport]  — override https/http
 * @param {object} [opts.env]        — env source (for testing)
 * @returns {Promise<{recipes: object[]}|null>}
 */
async function loadRemoteRecipes(url, opts = {}) {
  const env = opts.env || process.env;
  const cfg = (url && typeof url === 'string' && url.trim())
    ? { url: url.trim(), token: opts.token || (env && env[ENV_TOKEN_KEY]) || null }
    : readEnvConfig(env);

  if (!cfg) return null;

  const res = await httpRequest({
    url: cfg.url,
    method: 'GET',
    token: opts.token != null ? opts.token : cfg.token,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    transport: opts.transport,
  });

  if (!res) return null;
  if (typeof res.status !== 'number' || res.status < 200 || res.status >= 300) {
    logErr(`unexpected status ${res.status} on GET ${cfg.url}`);
    return null;
  }
  if (!res.body || typeof res.body !== 'object') {
    logErr(`malformed JSON body on GET ${cfg.url}`);
    return null;
  }
  if (!Array.isArray(res.body.recipes)) {
    // Accept a bare array as an alternative shape.
    if (Array.isArray(res.body)) return { recipes: res.body };
    logErr(`recipes is not an array on GET ${cfg.url}`);
    return { recipes: [] };
  }
  return { recipes: res.body.recipes };
}

/**
 * PUT (upsert) a single recipe to the remote store. Returns true on success,
 * false on any failure. Never throws.
 *
 * Body shape sent: the recipe object verbatim. Endpoint is expected to handle
 * de-duplication by `id`.
 *
 * @param {string} [url]
 * @param {object} recipe
 * @param {object} [opts] — same shape as loadRemoteRecipes opts; additionally
 *   `method` may be 'PUT' (default) or 'PATCH' or 'POST'
 * @returns {Promise<boolean>}
 */
async function saveRemoteRecipe(url, recipe, opts = {}) {
  if (!recipe || typeof recipe !== 'object') return false;

  const env = opts.env || process.env;
  const cfg = (url && typeof url === 'string' && url.trim())
    ? { url: url.trim(), token: opts.token || (env && env[ENV_TOKEN_KEY]) || null }
    : readEnvConfig(env);

  if (!cfg) return false;

  const method = (opts.method || 'PUT').toUpperCase();
  const res = await httpRequest({
    url: cfg.url,
    method,
    body: recipe,
    token: opts.token != null ? opts.token : cfg.token,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    transport: opts.transport,
  });

  if (!res) return false;
  if (typeof res.status !== 'number' || res.status < 200 || res.status >= 300) {
    logErr(`unexpected status ${res.status} on ${method} ${cfg.url}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

module.exports = {
  loadRemoteRecipes,
  saveRemoteRecipe,
  isRemoteConfigured,
  // exported for tests
  ENV_URL_KEY,
  ENV_TOKEN_KEY,
  DEFAULT_TIMEOUT_MS,
  _readEnvConfig: readEnvConfig,
  _httpRequest: httpRequest,
};
