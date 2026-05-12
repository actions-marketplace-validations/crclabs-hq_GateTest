// ============================================================================
// UNHANDLED-REJECTION GUARDS TEST
// ============================================================================
// Regression tripwire: Node.js v24 changed the default unhandledRejection
// behaviour from 'warn' to 'throw', which crashes the process. These tests
// confirm that the critical guards are present and will NOT be silently
// removed by a future session.
//
// Tests are file-content / listener-count checks — NOT integration tests.
// The goal is a fast, zero-network regression tripwire, not exhaustive coverage.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_SERVER_PATH = path.resolve(__dirname, '../src/app-server.js');
const SCAN_RUN_PATH   = path.resolve(__dirname, '../website/app/api/scan/run/route.ts');
const STRIPE_WH_PATH  = path.resolve(__dirname, '../website/app/api/stripe-webhook/route.ts');
const GITHUB_WH_PATH  = path.resolve(__dirname, '../website/app/api/webhook/route.ts');

// ── Test 1: app-server.js registers the process-level unhandledRejection guard
test('app-server.js contains process.on(unhandledRejection) safety-net guard', () => {
  const src = fs.readFileSync(APP_SERVER_PATH, 'utf-8');
  assert.ok(
    src.includes("process.on('unhandledRejection'"),
    "app-server.js must register a process-level unhandledRejection handler so a " +
    "single missed .catch() does not crash the server under Node 24"
  );
});

// ── Test 2: app-server.js registers the process-level uncaughtException guard
test('app-server.js contains process.on(uncaughtException) safety-net guard', () => {
  const src = fs.readFileSync(APP_SERVER_PATH, 'utf-8');
  assert.ok(
    src.includes("process.on('uncaughtException'"),
    "app-server.js must register a process-level uncaughtException handler"
  );
});

// ── Test 3: app-server.js registers the server-level clientError handler
test('app-server.js contains server.on(clientError) to handle malformed HTTP', () => {
  const src = fs.readFileSync(APP_SERVER_PATH, 'utf-8');
  assert.ok(
    src.includes("server.on('clientError'"),
    "app-server.js must register a clientError handler so malformed HTTP preambles " +
    "do not produce uncaught socket errors under Node 24"
  );
});

// ── Test 4: app-server.js guards the incoming request stream with req.on('error')
test('app-server.js guards the incoming webhook request stream with req.on(error)', () => {
  const src = fs.readFileSync(APP_SERVER_PATH, 'utf-8');
  // The pattern we added: req.on('error', ...) inside the /webhook handler so a
  // client that disconnects mid-upload doesn't produce an uncaughtException.
  assert.ok(
    /req\.on\('error'/.test(src),
    "app-server.js must attach a req.on('error') handler to the incoming webhook " +
    "request stream; without it a mid-upload disconnect produces an uncaughtException"
  );
});

// ── Test 5: scan/run route wraps the entire POST handler in an outer try/catch
test('scan/run route wraps the POST handler in an outer guard against unhandled rejections', () => {
  const src = fs.readFileSync(SCAN_RUN_PATH, 'utf-8');
  // After our fix, POST delegates to _postImpl inside a try/catch so any
  // unexpected throw (e.g. from extractIssuesFromModules) can never escape
  // as an unhandledRejection.
  assert.ok(
    src.includes('_postImpl'),
    "scan/run route.ts must contain a _postImpl helper called inside a top-level " +
    "try/catch on the POST function; this ensures no uncaught rejection can escape " +
    "if an inner guard is missed (Node 24 safety)"
  );
  // Confirm the outer POST does return await _postImpl(req) inside try/catch
  assert.ok(
    /return await _postImpl\(req\)/.test(src),
    "POST handler must 'return await _postImpl(req)' so the outer catch fires on " +
    "any async throw from _postImpl"
  );
});

// ── Test 6: stripe-webhook after() callback is wrapped in try/catch
test('stripe-webhook after() callback has a top-level try/catch', () => {
  const src = fs.readFileSync(STRIPE_WH_PATH, 'utf-8');
  // The after() callback runs AFTER the response is sent; an unhandled rejection
  // there kills the process. Confirm the try/catch wraps the whole callback body.
  const afterIdx = src.indexOf('after(async () => {');
  assert.ok(afterIdx !== -1, "stripe-webhook route.ts must contain an after(async () => { ... }) call");
  // The try/catch must appear inside the after() block
  const afterBlock = src.slice(afterIdx, afterIdx + 500);
  assert.ok(
    afterBlock.includes('try {'),
    "stripe-webhook after() callback must have a try/catch wrapping its body to " +
    "prevent unhandledRejection from killing the process under Node 24"
  );
});
