/**
 * Phase 6.2.3 — Datadog APM integration client.
 *
 * Fetches top error events and trace samples for a customer's services.
 * Used by the static↔runtime correlator to attach "this line is actively
 * throwing in prod" badges to GateTest findings.
 *
 * Auth: OAuth token stored encrypted in external_integrations table
 * (same pattern as Sentry client in Phase 5.3.1).
 *
 * API used: Datadog Logs Search + APM Traces
 * Docs: https://docs.datadoghq.com/api/latest/
 */

'use strict';

const DEFAULT_DD_SITE = 'datadoghq.com';
const ERRORS_LIMIT = 20;
const TRACES_LIMIT = 10;

/**
 * Fetch top error log events from Datadog Logs API.
 *
 * @param {object} opts
 * @param {string} opts.apiKey          Datadog API key
 * @param {string} opts.appKey          Datadog Application key
 * @param {string} [opts.service]       Service name filter
 * @param {string} [opts.site]          Datadog site (default: datadoghq.com)
 * @param {number} [opts.hoursBack]     Time window (default: 24h)
 */
async function fetchTopErrors(opts = {}) {
  const {
    apiKey,
    appKey,
    service,
    site = DEFAULT_DD_SITE,
    hoursBack = 24,
  } = opts;

  if (!apiKey || !appKey) throw new Error('Datadog apiKey and appKey are required');

  const fromTime = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const toTime = new Date().toISOString();

  const query = [
    'status:error',
    service ? `service:${service}` : null,
  ].filter(Boolean).join(' ');

  const body = JSON.stringify({
    filter: { query, from: fromTime, to: toTime },
    sort: '-timestamp',
    page: { limit: ERRORS_LIMIT },
  });

  const res = await fetch(`https://api.${site}/api/v2/logs/events/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': apiKey,
      'DD-APPLICATION-KEY': appKey,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Datadog Logs API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const events = data.data || [];

  return events.map(e => ({
    id: e.id,
    timestamp: e.attributes?.timestamp,
    message: e.attributes?.message,
    service: e.attributes?.service,
    status: e.attributes?.status,
    tags: e.attributes?.tags || [],
    // Extract file:line from stack trace if present
    sourceLocation: extractSourceLocation(e.attributes?.message || ''),
  }));
}

/**
 * Fetch APM trace samples for error spans.
 */
async function fetchErrorTraces(opts = {}) {
  const {
    apiKey,
    appKey,
    service,
    site = DEFAULT_DD_SITE,
    hoursBack = 24,
  } = opts;

  if (!apiKey || !appKey) throw new Error('Datadog apiKey and appKey are required');

  const fromTime = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000);
  const toTime = Math.floor(Date.now() / 1000);

  const params = new URLSearchParams({
    'filter[query]': `error:true${service ? ` service:${service}` : ''}`,
    'filter[from]': fromTime.toString(),
    'filter[to]': toTime.toString(),
    'page[limit]': String(TRACES_LIMIT),
    'sort': '-timestamp',
  });

  const res = await fetch(`https://api.${site}/api/v2/spans?${params}`, {
    headers: {
      'DD-API-KEY': apiKey,
      'DD-APPLICATION-KEY': appKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Datadog Traces API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const spans = data.data || [];

  return spans.map(s => ({
    id: s.id,
    service: s.attributes?.service,
    operationName: s.attributes?.name,
    resource: s.attributes?.resource,
    error: s.attributes?.error,
    duration: s.attributes?.duration,
    meta: s.attributes?.meta || {},
    sourceLocation: extractSourceLocation(s.attributes?.meta?.['error.stack'] || ''),
  }));
}

/**
 * Extract a file:line reference from a stack trace string.
 * Returns { file, line } or null.
 */
function extractSourceLocation(stackOrMessage) {
  if (!stackOrMessage) return null;

  // Node.js style: at Something (src/api/route.ts:42:10)
  const nodeMatch = stackOrMessage.match(/at\s+\S+\s+\(([^)]+):(\d+):\d+\)/);
  if (nodeMatch) return { file: nodeMatch[1], line: Number(nodeMatch[2]) };

  // Python style: File "src/api/route.py", line 42
  const pyMatch = stackOrMessage.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
  if (pyMatch) return { file: pyMatch[1], line: Number(pyMatch[2]) };

  return null;
}

module.exports = { fetchTopErrors, fetchErrorTraces, extractSourceLocation };
