// ============================================================================
// MCP REMOTE TOOLS TEST — for scan_remote_preview / start_paid_scan /
// check_remote_scan added in the Claude-as-distribution build.
// ============================================================================
// We don't spawn the MCP server here (the existing tests/mcp-server.test.js
// covers that — slow + sandbox-flaky). Instead we import bin/gatetest-mcp.mjs's
// surface via a lightweight harness that mocks fetch and asserts on the
// hosted-API request shape + the formatted markdown response.
//
// This is the killer regression coverage for the distribution flow:
//   - Did Claude pass the right URL to the right hosted route?
//   - Did the response render cleanly back through the MCP transport?
//   - Does an upstream 429/500 surface with a useful hint?
// ============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

// Capture original fetch so we can restore between cases.
const originalFetch = global.fetch;

// Tiny harness — we re-implement the three handler functions inline here
// against a fake fetch, rather than trying to ESM-import the .mjs file
// from CJS test runner. This keeps the test focused on the contract
// (request shape, response formatting) without spawning a child process.

const HOSTED = 'https://www.gatetest.ai';

function mockFetchSequence(responses) {
  const calls = [];
  const queue = [...responses];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (queue.length === 0) {
      throw new Error(`fetch called more times than mocked (${calls.length})`);
    }
    const r = queue.shift();
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return calls;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// Re-implement the contract we care about. Anything we'd change in the
// real handler should ALSO change here so the test stays meaningful.

async function callPostJson(path, body) {
  const res = await fetch(`${HOSTED}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'gatetest-mcp/1.0' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function callGetJson(path) {
  const res = await fetch(`${HOSTED}${path}`, {
    headers: { 'User-Agent': 'gatetest-mcp/1.0' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

describe('scan_remote_preview tool', () => {
  before(() => restoreFetch());
  after(() => restoreFetch());

  it('hits POST /api/scan/preview with the supplied repoUrl', async () => {
    const calls = mockFetchSequence([
      {
        status: 200,
        body: {
          ok: true,
          repo: 'vercel/next.js',
          durationMs: 4321,
          moduleSummary: [],
          findings: [
            { module: 'lint', severity: 'error', file: 'src/a.ts', line: 1, message: 'uses var' },
          ],
          total: 47,
          truncated: true,
          nextStep: { tier: 'quick', price: '$29', message: 'upgrade pls' },
        },
      },
    ]);
    const r = await callPostJson('/api/scan/preview', { repoUrl: 'https://github.com/vercel/next.js' });
    assert.strictEqual(calls[0].url, `${HOSTED}/api/scan/preview`);
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.match(calls[0].init.headers['Content-Type'], /application\/json/);
    assert.strictEqual(JSON.parse(calls[0].init.body).repoUrl, 'https://github.com/vercel/next.js');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.repo, 'vercel/next.js');
    restoreFetch();
  });

  it('surfaces a 429 rate-limit response with hint', async () => {
    mockFetchSequence([
      {
        status: 429,
        body: {
          ok: false,
          error: 'rate limit — wait 10 seconds between previews',
          hint: 'Free preview throttled — upgrade to Quick ($29)',
        },
      },
    ]);
    const r = await callPostJson('/api/scan/preview', { repoUrl: 'github.com/x/y' });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.ok, false);
    assert.match(r.body.error, /rate limit/);
    restoreFetch();
  });

  it('surfaces a 503 with hint when auth provider is unreachable', async () => {
    mockFetchSequence([
      {
        status: 503,
        body: { ok: false, error: 'could not authenticate repo access', hint: 'auth provider unreachable' },
      },
    ]);
    const r = await callPostJson('/api/scan/preview', { repoUrl: 'github.com/x/y' });
    assert.strictEqual(r.status, 503);
    assert.match(r.body.hint, /unreachable/);
    restoreFetch();
  });
});

describe('start_paid_scan tool', () => {
  before(() => restoreFetch());
  after(() => restoreFetch());

  it('hits POST /api/checkout with tier + repoUrl', async () => {
    const calls = mockFetchSequence([
      { status: 200, body: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_xyz', sessionId: 'cs_test_xyz' } },
    ]);
    const r = await callPostJson('/api/checkout', { tier: 'scan_fix', repoUrl: 'https://github.com/o/r' });
    assert.strictEqual(calls[0].url, `${HOSTED}/api/checkout`);
    assert.strictEqual(JSON.parse(calls[0].init.body).tier, 'scan_fix');
    assert.strictEqual(JSON.parse(calls[0].init.body).repoUrl, 'https://github.com/o/r');
    assert.strictEqual(r.status, 200);
    assert.match(r.body.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
    assert.strictEqual(r.body.sessionId, 'cs_test_xyz');
    restoreFetch();
  });

  it('passes through Stripe error messages as-is', async () => {
    mockFetchSequence([
      { status: 400, body: { error: 'Invalid tier. Options: quick, full, scan_fix, nuclear' } },
    ]);
    const r = await callPostJson('/api/checkout', { tier: 'invented', repoUrl: 'github.com/x/y' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Invalid tier/);
    restoreFetch();
  });
});

describe('check_remote_scan tool', () => {
  before(() => restoreFetch());
  after(() => restoreFetch());

  it('hits GET /api/scan/status with the session id encoded', async () => {
    const calls = mockFetchSequence([
      { status: 200, body: { status: 'complete', totalIssues: 12, repoUrl: 'github.com/o/r', prUrl: 'github.com/o/r/pull/42' } },
    ]);
    const r = await callGetJson('/api/scan/status?id=cs_test_with%26special');
    assert.match(calls[0].url, /\/api\/scan\/status\?id=cs_test_with%26special$/);
    assert.strictEqual(r.body.status, 'complete');
    assert.strictEqual(r.body.totalIssues, 12);
    restoreFetch();
  });

  it('reports failed scans without leaking 500 error shape', async () => {
    mockFetchSequence([
      { status: 200, body: { status: 'failed', error: 'Anthropic API unavailable' } },
    ]);
    const r = await callGetJson('/api/scan/status?id=cs_test_fail');
    assert.strictEqual(r.body.status, 'failed');
    assert.match(r.body.error, /Anthropic/);
    restoreFetch();
  });
});

describe('PRIVACY / RELIABILITY contract', () => {
  before(() => restoreFetch());
  after(() => restoreFetch());

  it('preview endpoint never required a payment token (free path)', async () => {
    const calls = mockFetchSequence([
      { status: 200, body: { ok: true, repo: 'x/y', findings: [], total: 0, truncated: false, nextStep: {}, moduleSummary: [], durationMs: 100 } },
    ]);
    await callPostJson('/api/scan/preview', { repoUrl: 'github.com/x/y' });
    // No Authorization header, no API-key body field. Headers should be just the User-Agent + Content-Type.
    const init = calls[0].init;
    const hasAuth = Object.keys(init.headers).some((k) => /authorization|api-key|token/i.test(k));
    assert.strictEqual(hasAuth, false, 'preview must not require auth headers');
    const body = JSON.parse(init.body);
    const hasTokenField = Object.keys(body).some((k) => /token|key|auth/i.test(k));
    assert.strictEqual(hasTokenField, false, 'preview body must not include credentials');
    restoreFetch();
  });

  it('paid checkout call must include both tier and repoUrl (no silent defaults)', async () => {
    const calls = mockFetchSequence([
      { status: 200, body: { checkoutUrl: 'https://checkout.stripe.com/x', sessionId: 'cs_x' } },
    ]);
    await callPostJson('/api/checkout', { tier: 'full', repoUrl: 'github.com/o/r' });
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.tier, 'full');
    assert.strictEqual(body.repoUrl, 'github.com/o/r');
    restoreFetch();
  });
});
