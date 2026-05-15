'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  signBody,
  verifySignature,
  buildDispatchPayload,
  dispatchRuntimeScan,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} = require('../website/app/lib/crontech-dispatch.js');

test('signBody — produces a hex digest', () => {
  const sig = signBody('hello', 'secret');
  assert.equal(typeof sig, 'string');
  assert.match(sig, /^[0-9a-f]{64}$/);
});

test('signBody — same input produces same signature', () => {
  const a = signBody('{"x":1}', 'shh');
  const b = signBody('{"x":1}', 'shh');
  assert.equal(a, b);
});

test('signBody — different body produces different signature', () => {
  const a = signBody('{"x":1}', 'shh');
  const b = signBody('{"x":2}', 'shh');
  assert.notEqual(a, b);
});

test('signBody — different secret produces different signature', () => {
  const a = signBody('hello', 'one');
  const b = signBody('hello', 'two');
  assert.notEqual(a, b);
});

test('signBody — throws on missing body / secret', () => {
  assert.throws(() => signBody(undefined, 'k'), /body must be a string/);
  assert.throws(() => signBody('x', ''), /secret is required/);
});

test('verifySignature — valid signature passes', () => {
  const body = '{"hello":"world"}';
  const sig = signBody(body, 'secret');
  assert.equal(verifySignature(body, sig, 'secret'), true);
});

test('verifySignature — wrong signature fails', () => {
  const body = '{"hello":"world"}';
  const wrong = 'a'.repeat(64);
  assert.equal(verifySignature(body, wrong, 'secret'), false);
});

test('verifySignature — wrong secret fails', () => {
  const body = '{"hello":"world"}';
  const sig = signBody(body, 'one');
  assert.equal(verifySignature(body, sig, 'two'), false);
});

test('verifySignature — tampered body fails', () => {
  const sig = signBody('original', 'secret');
  assert.equal(verifySignature('tampered', sig, 'secret'), false);
});

test('verifySignature — bad inputs fail safely', () => {
  assert.equal(verifySignature(null, 'x', 's'), false);
  assert.equal(verifySignature('body', null, 's'), false);
  assert.equal(verifySignature('body', 'x', null), false);
  assert.equal(verifySignature('body', '', 's'), false);
});

test('verifySignature — different-length signatures fail without throwing', () => {
  assert.equal(verifySignature('body', 'tooshort', 'secret'), false);
});

test('buildDispatchPayload — happy path', () => {
  const p = buildDispatchPayload({
    scanId: 'scn_abc',
    targetUrl: 'https://example.com',
    suite: 'web',
    callbackUrl: 'https://gatetest.ai/api/web/scan/runtime-callback',
  });
  assert.equal(p.scanId, 'scn_abc');
  assert.equal(p.targetUrl, 'https://example.com');
  assert.equal(p.suite, 'web');
  assert.equal(p.callbackUrl, 'https://gatetest.ai/api/web/scan/runtime-callback');
  assert.equal(p.deadlineSec, 60);
});

test('buildDispatchPayload — deadline clamped 10-300', () => {
  const p1 = buildDispatchPayload({ scanId: 'a', targetUrl: 'b', suite: 'c', callbackUrl: 'd', deadlineSec: 5 });
  assert.equal(p1.deadlineSec, 10);
  const p2 = buildDispatchPayload({ scanId: 'a', targetUrl: 'b', suite: 'c', callbackUrl: 'd', deadlineSec: 9999 });
  assert.equal(p2.deadlineSec, 300);
});

test('buildDispatchPayload — missing fields throw', () => {
  assert.throws(() => buildDispatchPayload({ targetUrl: 'a', suite: 'b', callbackUrl: 'c' }), /scanId is required/);
  assert.throws(() => buildDispatchPayload({ scanId: 'a', suite: 'b', callbackUrl: 'c' }), /targetUrl is required/);
  assert.throws(() => buildDispatchPayload({ scanId: 'a', targetUrl: 'b', callbackUrl: 'c' }), /suite is required/);
  assert.throws(() => buildDispatchPayload({ scanId: 'a', targetUrl: 'b', suite: 'c' }), /callbackUrl is required/);
});

test('dispatchRuntimeScan — returns reason when env vars missing', async () => {
  const r = await dispatchRuntimeScan({
    scanId: 'a',
    targetUrl: 'b',
    suite: 'web',
    callbackUrl: 'c',
    deps: {},
  });
  assert.equal(r.ok, false);
  assert.ok(/CRONTECH_BASE_URL/.test(r.reason));
});

test('dispatchRuntimeScan — happy path with injected fetch', async () => {
  let calledWith = null;
  const fakeFetch = async (url, opts) => {
    calledWith = { url, opts };
    return {
      ok: true,
      status: 201,
      json: async () => ({ jobId: 'crontech-job-42', queuedAt: '2026-05-15T00:00:00Z' }),
    };
  };
  const r = await dispatchRuntimeScan({
    scanId: 'scn_abc',
    targetUrl: 'https://example.com',
    suite: 'web',
    callbackUrl: 'https://gatetest.ai/cb',
    deps: {
      baseUrl: 'https://crontech.test',
      apiToken: 'tok_xyz',
      dispatchSecret: 'sh',
      fetchFn: fakeFetch,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.jobId, 'crontech-job-42');
  assert.equal(calledWith.url, 'https://crontech.test/api/jobs/web-runtime-scan');
  assert.equal(calledWith.opts.method, 'POST');
  assert.equal(calledWith.opts.headers['Authorization'], 'Bearer tok_xyz');
  // Signature header present + a valid hex digest
  assert.ok(calledWith.opts.headers[SIGNATURE_HEADER]);
  assert.match(calledWith.opts.headers[SIGNATURE_HEADER], /^[0-9a-f]{64}$/);
  // Timestamp header is a positive integer string
  assert.ok(Number(calledWith.opts.headers[TIMESTAMP_HEADER]) > 0);
});

test('dispatchRuntimeScan — non-200 returns failure with status', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'Crontech temporarily unavailable',
  });
  const r = await dispatchRuntimeScan({
    scanId: 'a',
    targetUrl: 'b',
    suite: 'c',
    callbackUrl: 'd',
    deps: {
      baseUrl: 'https://crontech.test',
      apiToken: 'tok',
      dispatchSecret: 'sh',
      fetchFn: fakeFetch,
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('dispatchRuntimeScan — missing jobId in response counts as failure', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 201,
    json: async () => ({}),
  });
  const r = await dispatchRuntimeScan({
    scanId: 'a',
    targetUrl: 'b',
    suite: 'c',
    callbackUrl: 'd',
    deps: {
      baseUrl: 'https://crontech.test',
      apiToken: 'tok',
      dispatchSecret: 'sh',
      fetchFn: fakeFetch,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing jobId/);
});

test('dispatchRuntimeScan — non-JSON body counts as failure', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 201,
    json: async () => { throw new Error('not json'); },
  });
  const r = await dispatchRuntimeScan({
    scanId: 'a',
    targetUrl: 'b',
    suite: 'c',
    callbackUrl: 'd',
    deps: {
      baseUrl: 'https://crontech.test',
      apiToken: 'tok',
      dispatchSecret: 'sh',
      fetchFn: fakeFetch,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-JSON/);
});

test('dispatchRuntimeScan — payload validation propagates', async () => {
  const fakeFetch = async () => ({ ok: true, status: 201, json: async () => ({ jobId: 'x' }) });
  const r = await dispatchRuntimeScan({
    // missing scanId
    targetUrl: 'b',
    suite: 'c',
    callbackUrl: 'd',
    deps: {
      baseUrl: 'https://crontech.test',
      apiToken: 'tok',
      dispatchSecret: 'sh',
      fetchFn: fakeFetch,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /scanId is required/);
});

test('dispatchRuntimeScan — fetch throw is caught', async () => {
  const fakeFetch = async () => { throw new Error('connection refused'); };
  const r = await dispatchRuntimeScan({
    scanId: 'a',
    targetUrl: 'b',
    suite: 'c',
    callbackUrl: 'd',
    deps: {
      baseUrl: 'https://crontech.test',
      apiToken: 'tok',
      dispatchSecret: 'sh',
      fetchFn: fakeFetch,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /connection refused/);
});
