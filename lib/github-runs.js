/**
 * GitHub Actions runs/jobs/logs REST wrapper — lightweight, no deps,
 * honours rate-limit Retry-After, hermetically testable via injected
 * transport.
 *
 * Used by `gatetest replay` to fetch the workflow run metadata, the jobs
 * inside it, and (optionally) the logs of failed jobs. The shape mirrors
 * `lib/ai-ci-fixer-core.js` so the two share a transport pattern and the
 * fakeTransport helper in tests works for both.
 */

'use strict';

const https = require('node:https');

const DEFAULT_HOST = 'api.github.com';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250;

// ── Low-level request ───────────────────────────────────────────────────────

/**
 * Single request to api.github.com. Returns { status, body, headers, raw }.
 *
 * Token may be null — falls back to unauthenticated (60 req/hour limit).
 * Body bytes are returned as a Buffer if the response is non-JSON (e.g.
 * the logs endpoint returns gzipped binary or a 302 to a signed URL).
 */
function _rawRequest(opts) {
  const {
    token,
    method = 'GET',
    urlPath,
    transport,
    host = DEFAULT_HOST,
    headers = {},
  } = opts;
  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: host,
      port: 443,
      path: urlPath,
      method,
      headers: {
        'Accept':              'application/vnd.github+json',
        'User-Agent':          'gatetest-replay',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...headers,
      },
    };
    const t = transport || https;
    const req = t.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = raw;
        const ct = (res.headers && res.headers['content-type']) || '';
        if (raw && ct.includes('json')) {
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
        }
        resolve({
          status: res.statusCode,
          body: parsed,
          headers: res.headers || {},
          raw,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Retry policy ────────────────────────────────────────────────────────────

function _parseRetryAfter(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (!raw) return null;
  const n = parseInt(String(raw).trim(), 10);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  // HTTP date — parse it and convert to ms from now.
  const t = Date.parse(String(raw));
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make a request with bounded retries. Honours Retry-After on 429.
 * Retries 5xx with exponential backoff. Returns the final response
 * (which may still be an error response) or throws on persistent
 * network failure.
 *
 * Cap = MAX_RETRIES (3). After the cap, returns whatever the final
 * response is so the caller can decide (per spec: NEVER block the user).
 */
async function _requestWithRetry(opts) {
  let lastErr = null;
  let lastResponse = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await _rawRequest(opts);
      lastResponse = res;
      if (res.status === 429) {
        const wait = _parseRetryAfter(res.headers) ?? (BASE_DELAY_MS * Math.pow(2, attempt));
        if (attempt < MAX_RETRIES) {
          await _sleep(wait);
          continue;
        }
        return res;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < MAX_RETRIES) {
          await _sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return res;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await _sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastErr || new Error('github-runs: request failed with no response');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the workflow run metadata.
 * Returns the parsed body on 200, or null on 404 / persistent error.
 */
async function fetchRun({ owner, repo, runId, token, transport }) {
  if (!owner || !repo || !runId) {
    throw new Error('fetchRun requires owner, repo, runId');
  }
  const urlPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`;
  try {
    const res = await _requestWithRetry({ token, urlPath, transport });
    if (res.status === 200 && res.body && typeof res.body === 'object') return res.body;
    if (res.status === 404) return null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the jobs for a workflow run.
 * Returns an array on 200 (possibly empty), or [] on 404 / persistent error.
 */
async function fetchJobs({ owner, repo, runId, token, transport }) {
  if (!owner || !repo || !runId) {
    throw new Error('fetchJobs requires owner, repo, runId');
  }
  const urlPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`;
  try {
    const res = await _requestWithRetry({ token, urlPath, transport });
    if (res.status === 200 && res.body && Array.isArray(res.body.jobs)) {
      return res.body.jobs;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Fetch logs for a single job. GitHub returns a 302 to a short-lived S3
 * signed URL; we follow it once. Returns the body text on success, or
 * null on persistent failure.
 *
 * NEVER throws — replay must continue even if logs are unavailable.
 */
async function fetchJobLogs({ owner, repo, jobId, token, transport }) {
  if (!owner || !repo || !jobId) {
    throw new Error('fetchJobLogs requires owner, repo, jobId');
  }
  const urlPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${encodeURIComponent(jobId)}/logs`;
  try {
    const res = await _requestWithRetry({ token, urlPath, transport });

    // Direct 200 with body — return it.
    if (res.status === 200 && typeof res.raw === 'string' && res.raw.length > 0) {
      return res.raw;
    }
    if (res.status === 200 && typeof res.body === 'string') {
      return res.body;
    }

    // 302/301 — follow once. The signed URL is on a different host so
    // we use a fresh request with no auth header (signed URL embeds creds).
    if (res.status === 302 || res.status === 301) {
      const location = res.headers && (res.headers.location || res.headers.Location);
      if (!location) return null;
      const followed = await _fetchSignedUrl(location, transport);
      return followed;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Follow a redirect to a signed URL (no auth). Used by fetchJobLogs.
 * Only supports https. Strips Authorization so we don't leak the
 * customer's token to a third-party signed URL.
 */
async function _fetchSignedUrl(location, transport) {
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const opts = {
    method: 'GET',
    urlPath: `${parsed.pathname}${parsed.search}`,
    host: parsed.hostname,
    transport,
    headers: {
      // Explicitly do NOT pass Authorization here.
      'Accept':     '*/*',
      'User-Agent': 'gatetest-replay',
    },
  };
  try {
    const res = await _rawRequest(opts);
    if (res.status === 200) {
      return typeof res.raw === 'string' ? res.raw : '';
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  fetchRun,
  fetchJobs,
  fetchJobLogs,
  // Internal — exposed for tests only.
  _parseRetryAfter,
  _rawRequest,
  _requestWithRetry,
  MAX_RETRIES,
};
