/**
 * Tests for website/app/lib/recipe-store-remote.js
 *
 * Every test uses an injected `transport` (no real HTTPS). Tests verify:
 *   - GET success → returns { recipes: [...] }
 *   - GET non-2xx / malformed JSON / timeout → returns null
 *   - PUT success → returns true
 *   - PUT non-2xx / timeout → returns false
 *   - Auth header presence when token is set
 *   - No-URL-configured returns early (null / false)
 *   - isRemoteConfigured env-var detection
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const remote = require('../website/app/lib/recipe-store-remote');

// ---------------------------------------------------------------------------
// Fake transport — captures calls and returns canned responses
// ---------------------------------------------------------------------------

function fakeTransport({ calls = [], responses = [], simulateTimeout = false, throwOnRequest = false } = {}) {
  return {
    request(opts, cb) {
      const record = {
        method:  opts.method,
        hostname:opts.hostname,
        port:    opts.port,
        path:    opts.path,
        headers: { ...opts.headers },
        _body:   '',
      };
      calls.push(record);

      if (throwOnRequest) {
        throw new Error('throw-on-request');
      }

      const fakeReq = {
        on(event, fn) {
          if (event === 'error' && fakeReq._errCb == null) fakeReq._errCb = fn;
          if (event === 'close') fakeReq._closeCb = fn;
        },
        write(chunk) { record._body += String(chunk); },
        end() { /* deferred fire below */ },
        destroy(err) {
          if (fakeReq._errCb) {
            try { fakeReq._errCb(err || new Error('destroyed')); } catch { /* ignore */ }
          }
          if (fakeReq._closeCb) {
            try { fakeReq._closeCb(); } catch { /* ignore */ }
          }
        },
      };

      if (simulateTimeout) {
        // Never invoke cb — let the consumer's timeout fire.
        return fakeReq;
      }

      const match = responses.shift() || responses[0] || { status: 404, body: { message: 'unmatched' } };

      setImmediate(() => {
        const raw = typeof match.body === 'string' ? match.body : JSON.stringify(match.body);
        const res = {
          statusCode: match.status,
          headers:    { 'content-type': 'application/json', ...(match.headers || {}) },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end')  fn();
          },
        };
        cb(res);
        if (fakeReq._closeCb) setImmediate(() => fakeReq._closeCb());
      });

      return fakeReq;
    },
  };
}

// ---------------------------------------------------------------------------
// isRemoteConfigured
// ---------------------------------------------------------------------------

test('isRemoteConfigured returns false when env var is unset', () => {
  assert.equal(remote.isRemoteConfigured({}), false);
  assert.equal(remote.isRemoteConfigured({ [remote.ENV_URL_KEY]: '' }), false);
  assert.equal(remote.isRemoteConfigured({ [remote.ENV_URL_KEY]: '   ' }), false);
});

test('isRemoteConfigured returns true when env var is set to a real URL', () => {
  assert.equal(remote.isRemoteConfigured({ [remote.ENV_URL_KEY]: 'https://example.com/recipes' }), true);
});

test('isRemoteConfigured handles missing env gracefully', () => {
  // Pass `null` — should not throw.
  assert.equal(remote.isRemoteConfigured(null), false);
});

// ---------------------------------------------------------------------------
// loadRemoteRecipes (GET)
// ---------------------------------------------------------------------------

test('loadRemoteRecipes returns recipes on 200 success', async () => {
  const transport = fakeTransport({
    responses: [{
      status: 200,
      body: { recipes: [
        { id: 'r1', ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', fileExt: '.js', before: 'foo', after: 'bar' },
      ] },
    }],
  });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.ok(result, 'should return a result object');
  assert.ok(Array.isArray(result.recipes));
  assert.equal(result.recipes.length, 1);
  assert.equal(result.recipes[0].id, 'r1');
});

test('loadRemoteRecipes returns null on non-2xx status', async () => {
  const transport = fakeTransport({
    responses: [{ status: 500, body: { error: 'server boom' } }],
  });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.equal(result, null);
});

test('loadRemoteRecipes returns null on 404', async () => {
  const transport = fakeTransport({
    responses: [{ status: 404, body: { error: 'not found' } }],
  });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.equal(result, null);
});

test('loadRemoteRecipes returns null on malformed JSON response', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: '{ not valid json' }],
  });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
});

test('loadRemoteRecipes returns null when no URL is configured', async () => {
  // No URL passed, env empty.
  const result = await remote.loadRemoteRecipes(undefined, { transport: fakeTransport(), env: {} });
  assert.equal(result, null);
});

test('loadRemoteRecipes returns null when URL is empty string', async () => {
  const result = await remote.loadRemoteRecipes('', { transport: fakeTransport(), env: {} });
  assert.equal(result, null);
});

test('loadRemoteRecipes resolves null on timeout', async () => {
  const transport = fakeTransport({ simulateTimeout: true });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', {
    transport,
    timeoutMs: 50,
  });
  assert.equal(result, null);
});

test('loadRemoteRecipes accepts a bare array body shape', async () => {
  const transport = fakeTransport({
    responses: [{
      status: 200,
      body: [{ id: 'bare-1', ruleKey: 'x', module: 'y', fileExt: '.js', before: 'a', after: 'b' }],
    }],
  });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.ok(result);
  assert.equal(result.recipes.length, 1);
  assert.equal(result.recipes[0].id, 'bare-1');
});

test('loadRemoteRecipes returns empty list when body.recipes is missing', async () => {
  const transport = fakeTransport({
    responses: [{ status: 200, body: { somethingElse: true } }],
  });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.ok(result);
  assert.deepEqual(result.recipes, []);
});

// ---------------------------------------------------------------------------
// Auth header
// ---------------------------------------------------------------------------

test('loadRemoteRecipes sends Authorization header when token is set', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: { recipes: [] } }],
  });
  await remote.loadRemoteRecipes('https://example.test/recipes', {
    token: 'secret-token-123',
    transport,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token-123');
});

test('loadRemoteRecipes does NOT send Authorization header when token is not set', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: { recipes: [] } }],
  });
  await remote.loadRemoteRecipes('https://example.test/recipes', {
    transport,
    env: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('loadRemoteRecipes uses env GATETEST_RECIPE_STORE_TOKEN when token opt is unset', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: { recipes: [] } }],
  });
  await remote.loadRemoteRecipes('https://example.test/recipes', {
    transport,
    env: { [remote.ENV_TOKEN_KEY]: 'env-token-xyz' },
  });
  assert.equal(calls[0].headers.Authorization, 'Bearer env-token-xyz');
});

// ---------------------------------------------------------------------------
// saveRemoteRecipe (PUT)
// ---------------------------------------------------------------------------

test('saveRemoteRecipe returns true on 200 success', async () => {
  const transport = fakeTransport({
    responses: [{ status: 200, body: { ok: true } }],
  });
  const ok = await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'new-recipe',
    ruleKey: 'r',
    module: 'm',
    fileExt: '.js',
    before: 'before',
    after: 'after',
  }, { transport });
  assert.equal(ok, true);
});

test('saveRemoteRecipe returns true on 201 Created', async () => {
  const transport = fakeTransport({
    responses: [{ status: 201, body: { id: 'new-recipe' } }],
  });
  const ok = await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'new-recipe', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport });
  assert.equal(ok, true);
});

test('saveRemoteRecipe returns false on 5xx', async () => {
  const transport = fakeTransport({
    responses: [{ status: 503, body: { error: 'service unavailable' } }],
  });
  const ok = await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'r', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport });
  assert.equal(ok, false);
});

test('saveRemoteRecipe returns false on timeout', async () => {
  const transport = fakeTransport({ simulateTimeout: true });
  const ok = await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'r', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport, timeoutMs: 50 });
  assert.equal(ok, false);
});

test('saveRemoteRecipe returns false when no URL is configured', async () => {
  const ok = await remote.saveRemoteRecipe(undefined, {
    id: 'r', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport: fakeTransport(), env: {} });
  assert.equal(ok, false);
});

test('saveRemoteRecipe returns false on null recipe', async () => {
  const ok = await remote.saveRemoteRecipe('https://example.test/recipes', null, {
    transport: fakeTransport(),
  });
  assert.equal(ok, false);
});

test('saveRemoteRecipe uses PUT by default and sends recipe body', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: { ok: true } }],
  });
  await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'r1', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'before-snippet', after: 'after-snippet',
  }, { transport });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  // Body should be valid JSON containing the recipe id.
  const parsed = JSON.parse(calls[0]._body);
  assert.equal(parsed.id, 'r1');
  assert.equal(parsed.before, 'before-snippet');
});

test('saveRemoteRecipe honors method=POST when supplied', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: { ok: true } }],
  });
  await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'r1', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport, method: 'POST' });
  assert.equal(calls[0].method, 'POST');
});

test('saveRemoteRecipe sends Authorization header when token is set', async () => {
  const calls = [];
  const transport = fakeTransport({
    calls,
    responses: [{ status: 200, body: { ok: true } }],
  });
  await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'r1', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport, token: 'tok-1' });
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
});

// ---------------------------------------------------------------------------
// Resilience — never throw
// ---------------------------------------------------------------------------

test('loadRemoteRecipes handles transport.request throwing without crashing', async () => {
  const transport = fakeTransport({ throwOnRequest: true });
  const result = await remote.loadRemoteRecipes('https://example.test/recipes', { transport });
  assert.equal(result, null);
});

test('saveRemoteRecipe handles transport.request throwing without crashing', async () => {
  const transport = fakeTransport({ throwOnRequest: true });
  const ok = await remote.saveRemoteRecipe('https://example.test/recipes', {
    id: 'r', ruleKey: 'r', module: 'm', fileExt: '.js', before: 'b', after: 'a',
  }, { transport });
  assert.equal(ok, false);
});

test('loadRemoteRecipes returns null for invalid URLs', async () => {
  const result = await remote.loadRemoteRecipes('not-a-real-url', {
    transport: fakeTransport(),
  });
  assert.equal(result, null);
});

test('environment variable names are stable constants', () => {
  assert.equal(remote.ENV_URL_KEY, 'GATETEST_RECIPE_STORE_URL');
  assert.equal(remote.ENV_TOKEN_KEY, 'GATETEST_RECIPE_STORE_TOKEN');
});
