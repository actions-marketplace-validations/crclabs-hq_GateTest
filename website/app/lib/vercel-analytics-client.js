/**
 * Phase 6.2.3 — Vercel Analytics + Speed Insights client.
 *
 * Pulls page-load p95 latencies, serverless function error rates, and
 * Web Vitals per route so the static↔runtime correlator can ask:
 * "the finding at /api/checkout.ts line 42 — did this route degrade
 * in prod in the last 7 days?"
 *
 * Auth: Vercel REST API token (stored encrypted in external_integrations).
 * Scope: read:analytics on the team's project.
 *
 * API: https://vercel.com/docs/rest-api
 */

'use strict';

const VERCEL_API_BASE = 'https://api.vercel.com';
const DEFAULT_SINCE_HOURS = 24 * 7;

/**
 * Normalize a URL path for aggregation.
 * - Strips query strings
 * - Replaces numeric IDs with :id
 * - Strips trailing slashes
 */
function normaliseRoute(path) {
  if (!path) return '';

  // Strip query string
  let normalized = path.split('?')[0];

  // Strip trailing slash (but keep root as empty)
  if (normalized === '/') return '';
  normalized = normalized.replace(/\/$/, '');

  // Replace numeric segments with :id
  normalized = normalized.replace(/\/\d+/g, '/:id');

  return normalized;
}

/**
 * Aggregate error events by normalized route.
 */
function aggregateEvents(events) {
  if (!events || events.length === 0) return [];

  const routeMap = new Map();

  for (const event of events) {
    if (event.type !== 'error') continue;

    const path = event.payload?.path || event.path;
    if (!path) continue;

    const route = normaliseRoute(path);
    if (!route && route !== '') continue;

    if (!routeMap.has(route)) {
      routeMap.set(route, {
        route,
        errorCount: 0,
        lastSeen: event.created,
      });
    }

    const entry = routeMap.get(route);
    entry.errorCount++;
    if (event.created > entry.lastSeen) {
      entry.lastSeen = event.created;
    }
  }

  return Array.from(routeMap.values());
}

/**
 * Fetch function metrics (deployments + events).
 */
async function fetchFunctionMetrics(opts = {}) {
  const { accessToken, projectId, teamId, sinceHours = DEFAULT_SINCE_HOURS } = opts;

  if (!accessToken) throw new Error('accessToken is required');
  if (!projectId) throw new Error('projectId is required');

  // Fetch recent deployments
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const params = new URLSearchParams({
    projectId,
    since,
    limit: '10',
    ...(teamId ? { teamId } : {}),
  });

  const deploymentsRes = await fetch(`${VERCEL_API_BASE}/v6/deployments?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!deploymentsRes.ok) {
    const text = await deploymentsRes.text();
    throw new Error(`Vercel API error ${deploymentsRes.status}: ${text.slice(0, 200)}`);
  }

  const deploymentsData = await deploymentsRes.json();
  const deployments = deploymentsData.deployments || [];

  if (deployments.length === 0) return [];

  // Fetch events for recent deployments (non-blocking)
  const allEvents = [];
  for (const dep of deployments.slice(0, 2)) {
    const eventsParams = new URLSearchParams({
      deploymentId: dep.uid,
      ...(teamId ? { teamId } : {}),
    });

    try {
      const eventsRes = await fetch(`${VERCEL_API_BASE}/v1/deployments/${dep.uid}/events?${eventsParams}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (eventsRes.ok) {
        const events = await eventsRes.json();
        if (Array.isArray(events)) {
          allEvents.push(...events);
        }
      }
    } catch (err) {
      // Non-blocking - continue if events fetch fails
      continue;
    }
  }

  return aggregateEvents(allEvents);
}

/**
 * Fetch Web Vitals and p95 latencies per route for a Vercel project.
 *
 * @param {object} opts
 * @param {string} opts.token       Vercel API token
 * @param {string} opts.projectId   Vercel project ID
 * @param {string} [opts.teamId]    Vercel team ID (for team projects)
 * @param {number} [opts.daysBack]  Time window (default: 7)
 */
async function fetchRoutePerformance(opts = {}) {
  const { token, projectId, teamId, daysBack = DEFAULT_DAYS } = opts;
  if (!token || !projectId) throw new Error('Vercel token and projectId are required');

  const from = Date.now() - daysBack * 86400 * 1000;
  const params = new URLSearchParams({
    projectId,
    from: String(from),
    ...(teamId ? { teamId } : {}),
  });

  const res = await fetch(`${VERCEL_API}/v1/web-analytics/vitals?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) {
    // Web Analytics not enabled on this project — return empty
    return [];
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel Analytics API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const routes = data.data || data || [];

  return routes.map(r => ({
    route: r.path || r.route || '/',
    lcp: r.lcp?.p95 ?? null,
    fid: r.fid?.p95 ?? null,
    cls: r.cls?.p95 ?? null,
    ttfb: r.ttfb?.p95 ?? null,
    pageViews: r.pageViews ?? r.visits ?? 0,
  }));
}

/**
 * Fetch serverless function invocation error rates per route.
 */
async function fetchFunctionErrors(opts = {}) {
  const { token, projectId, teamId, daysBack = DEFAULT_DAYS } = opts;
  if (!token || !projectId) throw new Error('Vercel token and projectId are required');

  const from = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();
  const params = new URLSearchParams({
    projectId,
    since: from,
    limit: '50',
    ...(teamId ? { teamId } : {}),
  });

  const res = await fetch(`${VERCEL_API}/v6/deployments?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel Deployments API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const deployments = data.deployments || [];

  // Return the most recent deployments with error indicators
  return deployments.slice(0, 10).map(d => ({
    id: d.uid,
    url: d.url,
    state: d.state,
    createdAt: d.createdAt,
    errorMessage: d.errorMessage || null,
    readyState: d.readyState,
  }));
}

module.exports = {
  normaliseRoute,
  aggregateEvents,
  fetchFunctionMetrics,
  fetchRoutePerformance,
  fetchFunctionErrors,
  VERCEL_API_BASE,
  DEFAULT_SINCE_HOURS,
};
