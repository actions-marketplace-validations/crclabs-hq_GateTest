/**
 * Phase 5.3.1 — Sentry API client.
 *
 * Wraps the Sentry REST API for the runtime correlator (5.3.4). Pure
 * JavaScript, dependency-injected fetch so tests don't hit the real
 * network. Returns normalised data shapes the correlator can match
 * against static findings.
 *
 * Two main capabilities:
 *
 *   1. exchangeOAuthCode(code, opts)
 *      Trades a Sentry OAuth authorization code for { accessToken,
 *      refreshToken, expiresAt }. Used by /api/integrations/sentry/callback.
 *
 *   2. fetchTopErrors({ orgId, accessToken, projectSlug, limit })
 *      Returns top N unresolved errors with their stack frames + counts.
 *      Result shape:
 *        [{ id, title, culprit, count, userCount, lastSeen, frames: [{ file, lineno, function }] }]
 *
 * The correlator treats `frames[i].file:frames[i].lineno` as the
 * cross-reference key — match against scan finding "src/foo.ts:42"
 * → flag the finding as 🔥 LIVE.
 *
 * Auth: Sentry uses Bearer tokens. We pull them from
 * external-integrations-store after decrypting.
 */

const SENTRY_API_BASE = 'https://sentry.io/api/0';
const SENTRY_OAUTH_TOKEN_URL = 'https://sentry.io/oauth/token/';

/**
 * Exchange an OAuth code for tokens. Used by the /api/integrations/sentry/callback
 * route. Pure function modulo the injected fetch.
 *
 * @param {object} opts
 * @param {string} opts.code - the authorization code Sentry redirected back with
 * @param {string} opts.clientId - SENTRY_CLIENT_ID
 * @param {string} opts.clientSecret - SENTRY_CLIENT_SECRET
 * @param {string} opts.redirectUri - the OAuth callback URI we registered
 * @param {Function} [opts.fetchImpl] - inject for tests
 * @returns {Promise<{ accessToken, refreshToken, expiresAt, scope, orgId }>}
 */
async function exchangeOAuthCode(opts) {
  const { code, clientId, clientSecret, redirectUri, fetchImpl = fetch } = opts;
  if (!code) throw new Error('exchangeOAuthCode: code is required');
  if (!clientId) throw new Error('exchangeOAuthCode: clientId is required');
  if (!clientSecret) throw new Error('exchangeOAuthCode: clientSecret is required');
  if (!redirectUri) throw new Error('exchangeOAuthCode: redirectUri is required');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const res = await fetchImpl(SENTRY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sentry OAuth exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Sentry returns: access_token, refresh_token, expires_in, token_type, scope, user (with org info)
  if (!data.access_token) {
    throw new Error('Sentry OAuth exchange returned no access_token');
  }
  let expiresAt = null;
  if (typeof data.expires_in === 'number' && data.expires_in > 0) {
    expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt,
    scope: data.scope || null,
    orgId: data.user?.organization?.slug || data.organization?.slug || null,
  };
}

/**
 * Fetch top N unresolved errors for a Sentry project, with frames.
 *
 * @param {object} opts
 * @param {string} opts.orgId - Sentry org slug (e.g. "my-startup")
 * @param {string} opts.projectSlug - Sentry project slug (e.g. "frontend")
 * @param {string} opts.accessToken - decrypted Bearer token
 * @param {number} [opts.limit=100] - max errors to fetch
 * @param {Function} [opts.fetchImpl=fetch] - inject for tests
 * @returns {Promise<Array<{ id, title, culprit, count, userCount, lastSeen, frames }>>}
 */
async function fetchTopErrors(opts) {
  const {
    orgId, projectSlug, accessToken, limit = 100, fetchImpl = fetch,
  } = opts;
  if (!orgId) throw new Error('fetchTopErrors: orgId is required');
  if (!projectSlug) throw new Error('fetchTopErrors: projectSlug is required');
  if (!accessToken) throw new Error('fetchTopErrors: accessToken is required');

  const url = `${SENTRY_API_BASE}/projects/${encodeURIComponent(orgId)}/${encodeURIComponent(projectSlug)}/issues/?query=is:unresolved&sort=freq&limit=${limit}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sentry API error (${res.status}): ${text.slice(0, 200)}`);
  }
  const issues = await res.json();
  if (!Array.isArray(issues)) {
    throw new Error('Sentry API returned non-array response');
  }

  const out = [];
  for (const issue of issues) {
    out.push(normaliseIssue(issue));
  }
  return out;
}

/**
 * Reduce a Sentry issue to the shape the correlator wants. Pure function.
 */
function normaliseIssue(issue) {
  if (!issue || typeof issue !== 'object') return null;
  const frames = extractFrames(issue);
  return {
    id: String(issue.id || ''),
    title: String(issue.title || issue.metadata?.title || ''),
    culprit: String(issue.culprit || ''),
    count: Number(issue.count || 0),
    userCount: Number(issue.userCount || 0),
    lastSeen: issue.lastSeen || null,
    frames,
  };
}

/**
 * Walk a Sentry issue's metadata and extract { file, lineno, function }
 * triples for every frame in the most-recent-event stack.
 */
function extractFrames(issue) {
  const frames = [];
  // Sentry's issue payload doesn't include full frames inline by
  // default — it provides metadata.in_app_frame OR a hint in metadata.
  // We pull whichever we can; the correlator can still match on
  // (filename, lineno).
  const metaFrames = issue?.metadata?.in_app_frames || issue?.metadata?.frames || [];
  if (Array.isArray(metaFrames)) {
    for (const f of metaFrames) {
      if (!f) continue;
      const file = String(f.filename || f.abs_path || '').replace(/^\/+/, '');
      const lineno = Number(f.lineno || f.line || 0) || null;
      const fn = String(f.function || f.method || '');
      if (file) frames.push({ file, lineno, function: fn });
    }
  }
  // Fallback: parse the culprit string "src/foo.ts in handler"
  if (frames.length === 0 && issue?.culprit) {
    const m = String(issue.culprit).match(/^([^\s]+\.[A-Za-z0-9]{1,8})(?:\s+in\s+(\S+))?/);
    if (m) {
      frames.push({ file: m[1], lineno: null, function: m[2] || '' });
    }
  }
  return frames;
}

/**
 * Bookkeeping: decide if a token is expired. Returns true if expiresAt
 * is set and is in the past.
 */
function isAccessTokenExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

module.exports = {
  SENTRY_API_BASE,
  SENTRY_OAUTH_TOKEN_URL,
  exchangeOAuthCode,
  fetchTopErrors,
  normaliseIssue,
  extractFrames,
  isAccessTokenExpired,
};
