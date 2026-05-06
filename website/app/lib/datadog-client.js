'use strict';

/**
 * Phase 5.3.2 / Phase 6.2.3 — Datadog Logs/APM integration.
 *
 * Queries the Datadog Logs API for error events and extracts file:line
 * stack frame information so the runtime-correlator can match them against
 * GateTest static findings.
 *
 * Auth: DD-API-KEY + DD-APPLICATION-KEY headers.
 * Site: datadoghq.com (US) or datadoghq.eu (EU).
 */

const DATADOG_API_BASE = 'https://api.datadoghq.com';
const DATADOG_EU_API_BASE = 'https://api.datadoghq.eu';
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_ERRORS = 100;

// ─── Stack frame extraction ───────────────────────────────────────────────────

const NODE_FRAME_RE = /at\s+\S+\s+\(([^)]+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+)(?::\d+)?\)/g;
const PYTHON_FRAME_RE = /File\s+"([^"]+\.(?:py|js|ts))",\s+line\s+(\d+)/g;

function extractStackFrames(text) {
  if (!text || typeof text !== 'string') return [];
  const frames = [];
  let match;

  const nodeRe = new RegExp(NODE_FRAME_RE.source, 'g');
  while ((match = nodeRe.exec(text)) !== null) {
    frames.push({ file: match[1], lineno: parseInt(match[2], 10) });
    if (frames.length >= 10) break;
  }

  if (frames.length === 0) {
    const pyRe = new RegExp(PYTHON_FRAME_RE.source, 'g');
    while ((match = pyRe.exec(text)) !== null) {
      frames.push({ file: match[1], lineno: parseInt(match[2], 10) });
      if (frames.length >= 10) break;
    }
  }

  return frames;
}

// ─── Event normalisation ──────────────────────────────────────────────────────

function normaliseEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const attrs = event.attributes || {};
  const tags = Array.isArray(attrs.tags) ? attrs.tags : [];
  const message = typeof attrs.message === 'string' ? attrs.message : '';
  const errMsg =
    (attrs.error && attrs.error.message) ||
    attrs['error.message'] ||
    message.split('\n')[0] ||
    '';

  const frames = extractStackFrames(message);

  // Also look in structured error fields
  const errStack = (attrs.error && attrs.error.stack) || attrs['error.stack'] || '';
  if (errStack && frames.length === 0) {
    frames.push(...extractStackFrames(errStack));
  }

  return {
    id: String(event.id || ''),
    message: errMsg,
    timestamp: String(attrs.timestamp || attrs.date || ''),
    service: tags.find((t) => t.startsWith('service:'))?.slice(8) || '',
    env: tags.find((t) => t.startsWith('env:'))?.slice(4) || '',
    frames,
  };
}

// ─── API client ───────────────────────────────────────────────────────────────

/**
 * Fetch top error events from Datadog Logs API.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey       - DD-API-KEY
 * @param {string} opts.appKey       - DD-APPLICATION-KEY
 * @param {string} [opts.query]      - Datadog log query (default: "status:error")
 * @param {string} [opts.site]       - "datadoghq.com" or "datadoghq.eu"
 * @param {number} [opts.lookbackDays]
 * @param {number} [opts.limit]
 * @returns {Promise<Array<{ id, message, timestamp, service, env, frames }>>}
 */
async function fetchTopErrors({
  apiKey,
  appKey,
  query = 'status:error',
  site = 'datadoghq.com',
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  limit = 50,
}) {
  if (!apiKey) throw new Error('fetchTopErrors: apiKey is required');
  if (!appKey) throw new Error('fetchTopErrors: appKey is required');

  const base = site === 'datadoghq.eu' ? DATADOG_EU_API_BASE : DATADOG_API_BASE;
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const body = {
    filter: {
      query,
      from: from.toISOString(),
      to: now.toISOString(),
    },
    sort: '-timestamp',
    page: { limit: Math.min(limit, MAX_ERRORS) },
  };

  const res = await fetch(`${base}/api/v2/logs/events/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': apiKey,
      'DD-APPLICATION-KEY': appKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Datadog API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const events = Array.isArray(json.data) ? json.data : [];
  return events.map(normaliseEvent).filter(Boolean);
}

module.exports = {
  fetchTopErrors,
  normaliseEvent,
  extractStackFrames,
  DATADOG_API_BASE,
  DATADOG_EU_API_BASE,
  DEFAULT_LOOKBACK_DAYS,
  MAX_ERRORS,
};
