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

const VERCEL_API = 'https://api.vercel.com';
const DEFAULT_DAYS = 7;

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

module.exports = { fetchRoutePerformance, fetchFunctionErrors };
