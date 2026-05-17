/**
 * Tests for lib/github-runs.js — REST wrapper with rate-limit retry.
 *
 * Hermetic: every external call goes through an injected fakeTransport
 * (same shape as tests/ai-ci-fixer.test.js — that pattern is the standard
 * across this repo).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchRun, fetchJobs, fetchJobLogs, _parseRetryAfter, MAX_RETRIES } = require('../lib/github-runs');

// ── fakeTransport ───────────────────────────────────────────────────────────

/**
 * Build a fake transport. Each call advances through `responses` in order
 * (so we can simulate a 429-then-200 retry sequence).
 *
 *   responses: [{ status, body, headers, raw? }]
 *
 * If `responses` is a function, it's called with (callIndex, requestOpts)
 * and returns the response object. Useful for path-conditioned tests.
 */
function fakeTransport(responses) {
  let callIndex = 0;
  const calls = [];
  const t = {
    request(opts, cb) {
      const i = callIndex++;
      const payload = typeof responses === 'function'
        ? responses(i, opts)
        : (responses[i] || responses[responses.length - 1] || { status: 404, body: {} });
      calls.push({ path: opts.path, headers: opts.headers, method: opts.method, host: opts.hostname });
      setImmediate(() => {
        const raw = payload.raw !== undefined
          ? payload.raw
          : (typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body || {}));
        const res = {
          statusCode: payload.status,
          headers: { 'content-type': 'application/json', ...(payload.headers || {}) },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end') fn();
          },
        };
        cb(res);
      });
      return { on() {}, write() {}, end() {}, destroy() {} };
    },
    _calls: calls,
  };
  return t;
}

// ── fetchRun ────────────────────────────────────────────────────────────────

test('fetchRun — happy path returns the run object', async () => {
  const transport = fakeTransport([{ status: 200, body: { id: 12345, name: 'CI', conclusion: 'failure' } }]);
  const run = await fetchRun({ owner: 'foo', repo: 'bar', runId: '12345', token: 't', transport });
  assert.equal(run.id, 12345);
  assert.equal(run.conclusion, 'failure');
});

test('fetchRun — 404 returns null', async () => {
  const transport = fakeTransport([{ status: 404, body: { message: 'Not Found' } }]);
  const run = await fetchRun({ owner: 'foo', repo: 'bar', runId: '99', token: 't', transport });
  assert.equal(run, null);
});

test('fetchRun — 429 with Retry-After is honored and retried', async () => {
  const transport = fakeTransport([
    { status: 429, body: { message: 'rate limited' }, headers: { 'retry-after': '0' } },
    { status: 200, body: { id: 1, name: 'CI' } },
  ]);
  const t0 = Date.now();
  const run = await fetchRun({ owner: 'o', repo: 'r', runId: '1', token: 't', transport });
  const elapsed = Date.now() - t0;
  assert.equal(run.id, 1);
  // We honored Retry-After:0 which is ~0ms, total under 200ms easily.
  assert.ok(elapsed < 2000, `elapsed=${elapsed}ms too slow`);
  assert.equal(transport._calls.length, 2);
});

test('fetchRun — persistent 5xx returns null (never throws)', async () => {
  const transport = fakeTransport([
    { status: 500, body: { message: 'server error' } },
    { status: 502, body: { message: 'bad gateway' } },
    { status: 503, body: { message: 'service unavailable' } },
  ]);
  const run = await fetchRun({ owner: 'o', repo: 'r', runId: '1', token: 't', transport });
  assert.equal(run, null);
  assert.equal(transport._calls.length, MAX_RETRIES);
});

test('fetchRun — passes Authorization when token provided', async () => {
  const transport = fakeTransport([{ status: 200, body: { id: 1 } }]);
  await fetchRun({ owner: 'o', repo: 'r', runId: '1', token: 'mytoken', transport });
  const headers = transport._calls[0].headers;
  assert.equal(headers.Authorization, 'Bearer mytoken');
});

test('fetchRun — omits Authorization when no token', async () => {
  const transport = fakeTransport([{ status: 200, body: { id: 1 } }]);
  await fetchRun({ owner: 'o', repo: 'r', runId: '1', token: null, transport });
  const headers = transport._calls[0].headers;
  assert.equal(headers.Authorization, undefined);
});

test('fetchRun — requires owner/repo/runId', async () => {
  await assert.rejects(() => fetchRun({ owner: '', repo: 'r', runId: '1' }));
  await assert.rejects(() => fetchRun({ owner: 'o', repo: '', runId: '1' }));
  await assert.rejects(() => fetchRun({ owner: 'o', repo: 'r', runId: '' }));
});

// ── fetchJobs ───────────────────────────────────────────────────────────────

test('fetchJobs — happy path returns the jobs array', async () => {
  const transport = fakeTransport([{
    status: 200,
    body: { jobs: [{ id: 1, name: 'Test', conclusion: 'failure' }, { id: 2, name: 'Build', conclusion: 'success' }] },
  }]);
  const jobs = await fetchJobs({ owner: 'o', repo: 'r', runId: '1', token: 't', transport });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].name, 'Test');
});

test('fetchJobs — 404 returns []', async () => {
  const transport = fakeTransport([{ status: 404, body: { message: 'Not Found' } }]);
  const jobs = await fetchJobs({ owner: 'o', repo: 'r', runId: '1', token: 't', transport });
  assert.deepEqual(jobs, []);
});

test('fetchJobs — malformed body returns []', async () => {
  const transport = fakeTransport([{ status: 200, body: { not: 'a jobs array' } }]);
  const jobs = await fetchJobs({ owner: 'o', repo: 'r', runId: '1', token: 't', transport });
  assert.deepEqual(jobs, []);
});

// ── fetchJobLogs ────────────────────────────────────────────────────────────

test('fetchJobLogs — follows 302 to signed URL and returns body', async () => {
  let call = 0;
  const transport = fakeTransport((i, opts) => {
    call = i;
    if (i === 0) {
      return {
        status: 302,
        body: '',
        headers: { 'location': 'https://signed.example.com/logs/abc', 'content-type': 'text/plain' },
      };
    }
    return { status: 200, body: 'log line 1\nlog line 2\n', headers: { 'content-type': 'text/plain' }, raw: 'log line 1\nlog line 2\n' };
  });
  const logs = await fetchJobLogs({ owner: 'o', repo: 'r', jobId: '42', token: 't', transport });
  assert.equal(logs, 'log line 1\nlog line 2\n');
  assert.equal(transport._calls.length, 2);
  // Second call hits the signed-URL host, NOT api.github.com.
  assert.equal(transport._calls[1].host, 'signed.example.com');
  // And does NOT carry the Authorization header — leaking the customer's
  // token to a third-party signed URL would be a security regression.
  assert.equal(transport._calls[1].headers.Authorization, undefined);
});

test('fetchJobLogs — returns null on persistent failure (never throws)', async () => {
  const transport = fakeTransport([
    { status: 500, body: '' },
    { status: 500, body: '' },
    { status: 500, body: '' },
  ]);
  const logs = await fetchJobLogs({ owner: 'o', repo: 'r', jobId: '1', token: 't', transport });
  assert.equal(logs, null);
});

test('fetchJobLogs — handles a 200-direct response (no redirect)', async () => {
  const transport = fakeTransport([{
    status: 200,
    body: '',
    raw: '##[group]Step 1\nbuild failed\n##[endgroup]',
    headers: { 'content-type': 'text/plain' },
  }]);
  const logs = await fetchJobLogs({ owner: 'o', repo: 'r', jobId: '1', token: 't', transport });
  assert.match(logs, /build failed/);
});

// ── _parseRetryAfter ────────────────────────────────────────────────────────

test('_parseRetryAfter — numeric value returns ms', () => {
  assert.equal(_parseRetryAfter({ 'retry-after': '5' }), 5000);
  assert.equal(_parseRetryAfter({ 'retry-after': '0' }), 0);
});

test('_parseRetryAfter — missing header returns null', () => {
  assert.equal(_parseRetryAfter({}), null);
  assert.equal(_parseRetryAfter(null), null);
});

test('_parseRetryAfter — HTTP-date returns ms-from-now', () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const ms = _parseRetryAfter({ 'retry-after': future });
  assert.ok(ms > 50_000 && ms < 70_000, `expected ~60s, got ${ms}`);
});
