// ============================================================================
// SENTRY-CLIENT TEST — Phase 5.3.1 of THE 110% MANDATE
// ============================================================================
// Pure-function coverage for the Sentry API wrapper. fetch is injected
// so tests never hit the real network.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  SENTRY_API_BASE,
  SENTRY_OAUTH_TOKEN_URL,
  exchangeOAuthCode,
  fetchTopErrors,
  normaliseIssue,
  extractFrames,
  isAccessTokenExpired,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'sentry-client.js'));

// ---------- shape ----------

test('exposes the canonical Sentry endpoints (so we never silently rewrite them)', () => {
  assert.strictEqual(SENTRY_API_BASE, 'https://sentry.io/api/0');
  assert.strictEqual(SENTRY_OAUTH_TOKEN_URL, 'https://sentry.io/oauth/token/');
});

// ---------- exchangeOAuthCode ----------

describe('exchangeOAuthCode', () => {
  it('POSTs the right body and returns normalised tokens', async () => {
    let captured = null;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => ({
          access_token: 'sntrys_xxx',
          refresh_token: 'rtkn_xxx',
          expires_in: 3600,
          scope: 'project:read',
          user: { organization: { slug: 'my-org' } },
        }),
      };
    };
    const result = await exchangeOAuthCode({
      code: 'auth-code-123',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://gatetest.ai/api/integrations/sentry/callback',
      fetchImpl: fakeFetch,
    });
    assert.strictEqual(result.accessToken, 'sntrys_xxx');
    assert.strictEqual(result.refreshToken, 'rtkn_xxx');
    assert.strictEqual(result.scope, 'project:read');
    assert.strictEqual(result.orgId, 'my-org');
    assert.ok(result.expiresAt, 'expiresAt should be computed from expires_in');

    assert.strictEqual(captured.url, SENTRY_OAUTH_TOKEN_URL);
    assert.strictEqual(captured.init.method, 'POST');
    assert.match(captured.init.body, /grant_type=authorization_code/);
    assert.match(captured.init.body, /code=auth-code-123/);
    assert.match(captured.init.body, /client_id=client-id/);
    // Never put cleartext client_secret in plain logs — but it does have
    // to go in the body for the OAuth exchange. Make sure it's sent.
    assert.match(captured.init.body, /client_secret=client-secret/);
  });

  it('throws on non-2xx response with truncated error body', async () => {
    const fakeFetch = async () => ({
      ok: false, status: 400,
      text: async () => 'invalid_grant: code expired',
    });
    await assert.rejects(
      () => exchangeOAuthCode({
        code: 'expired', clientId: 'a', clientSecret: 'b',
        redirectUri: 'c', fetchImpl: fakeFetch,
      }),
      /Sentry OAuth exchange failed \(400\)/
    );
  });

  it('throws when access_token is missing in response', async () => {
    const fakeFetch = async () => ({
      ok: true, json: async () => ({ refresh_token: 'r', expires_in: 100 }),
    });
    await assert.rejects(
      () => exchangeOAuthCode({
        code: 'c', clientId: 'a', clientSecret: 'b',
        redirectUri: 'd', fetchImpl: fakeFetch,
      }),
      /no access_token/
    );
  });

  it('rejects calls missing required fields', async () => {
    await assert.rejects(
      () => exchangeOAuthCode({ clientId: 'a', clientSecret: 'b', redirectUri: 'c' }),
      /code is required/
    );
    await assert.rejects(
      () => exchangeOAuthCode({ code: 'c', clientSecret: 'b', redirectUri: 'd' }),
      /clientId is required/
    );
  });
});

// ---------- fetchTopErrors ----------

describe('fetchTopErrors', () => {
  it('hits the right URL with Bearer auth and returns normalised issues', async () => {
    let captured = null;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => [
          {
            id: 'issue-1', title: 'TypeError: x is undefined',
            culprit: 'src/foo.ts in handler',
            count: 142, userCount: 23, lastSeen: '2026-04-29T10:00:00Z',
            metadata: {
              in_app_frames: [
                { filename: 'src/foo.ts', lineno: 42, function: 'handler' },
              ],
            },
          },
          {
            id: 'issue-2', title: 'NetworkError',
            culprit: 'src/api.ts',
            count: 99, userCount: 50, lastSeen: '2026-04-29T11:00:00Z',
            metadata: { frames: [{ filename: 'src/api.ts', lineno: 7 }] },
          },
        ],
      };
    };
    const result = await fetchTopErrors({
      orgId: 'my-org',
      projectSlug: 'frontend',
      accessToken: 'sntrys_token',
      limit: 50,
      fetchImpl: fakeFetch,
    });
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'issue-1');
    assert.strictEqual(result[0].count, 142);
    assert.strictEqual(result[0].frames[0].file, 'src/foo.ts');
    assert.strictEqual(result[0].frames[0].lineno, 42);
    assert.strictEqual(result[0].frames[0].function, 'handler');

    // Captured URL + auth shape
    assert.match(captured.url, /\/projects\/my-org\/frontend\/issues\//);
    assert.match(captured.url, /query=is:unresolved/);
    assert.match(captured.url, /sort=freq/);
    assert.match(captured.url, /limit=50/);
    assert.strictEqual(captured.init.headers.Authorization, 'Bearer sntrys_token');
  });

  it('throws on non-2xx response', async () => {
    const fakeFetch = async () => ({
      ok: false, status: 401,
      text: async () => 'invalid token',
    });
    await assert.rejects(
      () => fetchTopErrors({
        orgId: 'o', projectSlug: 'p', accessToken: 't',
        fetchImpl: fakeFetch,
      }),
      /Sentry API error \(401\)/
    );
  });

  it('rejects calls missing required fields', async () => {
    await assert.rejects(() => fetchTopErrors({ projectSlug: 'p', accessToken: 't' }), /orgId is required/);
    await assert.rejects(() => fetchTopErrors({ orgId: 'o', accessToken: 't' }), /projectSlug is required/);
    await assert.rejects(() => fetchTopErrors({ orgId: 'o', projectSlug: 'p' }), /accessToken is required/);
  });
});

// ---------- normaliseIssue ----------

describe('normaliseIssue', () => {
  it('returns null on garbage input', () => {
    assert.strictEqual(normaliseIssue(null), null);
    assert.strictEqual(normaliseIssue(undefined), null);
  });

  it('coerces missing fields to safe defaults', () => {
    const result = normaliseIssue({ id: 1 });
    assert.strictEqual(result.id, '1');
    assert.strictEqual(result.title, '');
    assert.strictEqual(result.count, 0);
  });
});

// ---------- extractFrames ----------

describe('extractFrames', () => {
  it('reads in_app_frames metadata first', () => {
    const frames = extractFrames({
      metadata: {
        in_app_frames: [
          { filename: 'src/a.ts', lineno: 10, function: 'foo' },
          { filename: 'src/b.ts', lineno: 20, function: 'bar' },
        ],
      },
    });
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].file, 'src/a.ts');
    assert.strictEqual(frames[0].lineno, 10);
  });

  it('falls back to .frames array when in_app_frames missing', () => {
    const frames = extractFrames({
      metadata: {
        frames: [{ filename: 'src/x.ts', lineno: 5 }],
      },
    });
    assert.strictEqual(frames[0].file, 'src/x.ts');
  });

  it('falls back to culprit-string parse when no metadata frames', () => {
    const frames = extractFrames({ culprit: 'src/foo.ts in handler' });
    assert.strictEqual(frames[0].file, 'src/foo.ts');
    assert.strictEqual(frames[0].function, 'handler');
  });

  it('strips leading slashes from filenames', () => {
    const frames = extractFrames({
      metadata: { in_app_frames: [{ filename: '/src/abs.ts', lineno: 1 }] },
    });
    assert.strictEqual(frames[0].file, 'src/abs.ts');
  });

  it('returns empty array when nothing useable', () => {
    assert.deepStrictEqual(extractFrames({}), []);
    assert.deepStrictEqual(extractFrames({ metadata: {} }), []);
    assert.deepStrictEqual(extractFrames(null), []);
  });
});

// ---------- isAccessTokenExpired ----------

describe('isAccessTokenExpired', () => {
  it('returns false when expiresAt is null/undefined (treat as non-expiring)', () => {
    assert.strictEqual(isAccessTokenExpired(null), false);
    assert.strictEqual(isAccessTokenExpired(undefined), false);
  });

  it('returns true when expiresAt is in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(isAccessTokenExpired(past), true);
  });

  it('returns false when expiresAt is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.strictEqual(isAccessTokenExpired(future), false);
  });

  it('returns false on garbage input (be conservative)', () => {
    assert.strictEqual(isAccessTokenExpired('not a date'), false);
  });
});
