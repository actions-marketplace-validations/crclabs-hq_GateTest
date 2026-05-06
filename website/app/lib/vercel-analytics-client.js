'use strict';

/**
 * Phase 5.3.3 / Phase 6.2.3 — Vercel Analytics integration.
 *
 * Fetches serverless function error rates and latency data per route from
 * the Vercel REST API. The runtime-correlator uses this to surface which
 * GateTest findings are on routes that are actually failing in production.
 *
 * Auth: Bearer access token (Vercel personal access token or OAuth token).
 * Scoped to a single project; teamId optional for personal accounts.
 */

const VERCEL_API_BASE = 'https://api.vercel.com';
const DEFAULT_SINCE_HOURS = 24 * 7; // 7 days

// ─── Route normalisation ──────────────────────────────────────────────────────

/**
 * Normalise a Vercel route path: strip query strings, collapse numeric IDs.
 */
function normaliseRoute(path) {
  if (!path || typeof path !== 'string') return '';
  return path
    .replace(/\?.*$/, '')             // strip query string
    .replace(/\/\d+(?=\/|$)/g, '/:id') // numeric segments → :id
    .replace(/\/$/, '');               // trailing slash
}

// ─── Event aggregation ────────────────────────────────────────────────────────

function aggregateEvents(events) {
  const routeMap = {};
  for (const ev of events) {
    if (!ev || ev.type !== 'error') continue;
    const rawPath = (ev.payload && ev.payload.path) || ev.path || '';
    const route = normaliseRoute(rawPath);
    if (!route) continue;
    if (!routeMap[route]) {
      routeMap[route] = { route, errorCount: 0, lastSeen: '' };
    }
    routeMap[route].errorCount++;
    const ts = String(ev.created || ev.timestamp || '');
    if (!routeMap[route].lastSeen || ts > routeMap[route].lastSeen) {
      routeMap[route].lastSeen = ts;
    }
  }
  return Object.values(routeMap);
}

// ─── API client ───────────────────────────────────────────────────────────────

/**
 * Fetch function error rates per route for a Vercel project.
 *
 * @param {Object} opts
 * @param {string} opts.accessToken  - Vercel personal access token
 * @param {string} opts.projectId    - Vercel project ID
 * @param {string} [opts.teamId]     - Vercel team ID (optional)
 * @param {number} [opts.sinceHours] - lookback window in hours
 * @returns {Promise<Array<{ route, errorCount, lastSeen }>>}
 */
async function fetchFunctionMetrics({
  accessToken,
  projectId,
  teamId,
  sinceHours = DEFAULT_SINCE_HOURS,
}) {
  if (!accessToken) throw new Error('fetchFunctionMetrics: accessToken is required');
  if (!projectId) throw new Error('fetchFunctionMetrics: projectId is required');

  const teamQuery = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
  const deploymentsUrl =
    `${VERCEL_API_BASE}/v6/deployments?limit=5&projectId=${encodeURIComponent(projectId)}${teamQuery}`;

  const deploymentsRes = await fetch(deploymentsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!deploymentsRes.ok) {
    const text = await deploymentsRes.text();
    throw new Error(`Vercel API error ${deploymentsRes.status}: ${text.slice(0, 200)}`);
  }

  const depsJson = await deploymentsRes.json();
  const deployments = Array.isArray(depsJson.deployments) ? depsJson.deployments : [];
  if (deployments.length === 0) return [];

  const since = Math.floor((Date.now() - sinceHours * 3600 * 1000) / 1000);
  const results = [];

  for (const dep of deployments.slice(0, 2)) {
    const depId = dep.uid || dep.id;
    if (!depId) continue;

    try {
      const eventsUrl = `${VERCEL_API_BASE}/v6/deployments/${encodeURIComponent(depId)}/events?limit=100&since=${since}`;
      const eventsRes = await fetch(eventsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!eventsRes.ok) continue;

      const eventsJson = await eventsRes.json();
      const events = Array.isArray(eventsJson) ? eventsJson : [];
      results.push(...aggregateEvents(events));
    } catch {
      // Non-blocking per deployment
    }
  }

  return results;
}

module.exports = {
  fetchFunctionMetrics,
  normaliseRoute,
  aggregateEvents,
  VERCEL_API_BASE,
  DEFAULT_SINCE_HOURS,
};
