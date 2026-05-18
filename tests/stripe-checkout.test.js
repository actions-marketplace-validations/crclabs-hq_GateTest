// ============================================================================
// STRIPE CHECKOUT TEST — Coverage for website/app/lib/stripe-checkout.js
// ============================================================================
// Verifies the pure helpers that back the Stripe checkout route at
// `website/app/api/checkout/route.ts`. All Stripe calls are mocked at the
// fetch boundary via an injected `fetchImpl` — nothing touches the real API.
//
// Covered paths:
//   - Valid request → session created with correct line items / metadata /
//     return URLs (success_url with {CHECKOUT_SESSION_ID} placeholder +
//     cancel_url)
//   - Invalid tier → 400
//   - Missing repo_url → 400
//   - Stripe API failure → 500 (network error, non-JSON body, non-ok HTTP)
//   - Stripe error response (well-formed `error.message`) → 400
//   - Missing STRIPE_SECRET_KEY → 503
//
// No live calls, no new deps. Uses node:test + node:assert.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  TIERS,
  validateCheckoutInput,
  buildStripeCheckoutParams,
  createCheckoutSession,
} = require(
  path.resolve(__dirname, '..', 'website', 'app', 'lib', 'stripe-checkout.js')
);

const VALID_REPO = 'https://github.com/crclabs-hq/gatetest';

// ---------------------------------------------------------------------------
// fetchImpl mock factory — captures the single call and returns a shaped
// response. Mirrors the subset of the Fetch Response interface that
// createCheckoutSession actually uses: ok, status, json().
// ---------------------------------------------------------------------------
function makeMockFetch({ ok = true, status = 200, body = {}, throws = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throws) {
      throw throws;
    }
    return {
      ok,
      status,
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// validateCheckoutInput — pure validation helper
// ---------------------------------------------------------------------------
describe('validateCheckoutInput', () => {
  it('rejects non-object input with 400', () => {
    for (const bad of [null, undefined, 'string', 42, true]) {
      const result = validateCheckoutInput(bad);
      assert.strictEqual(result.ok, false, `bad input: ${String(bad)}`);
      assert.strictEqual(result.status, 400);
      assert.match(result.error, /Invalid request body/);
    }
  });

  it('rejects missing tier with 400', () => {
    const result = validateCheckoutInput({ repoUrl: VALID_REPO });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /Invalid tier/);
  });

  it('rejects unknown tier with 400 and lists the valid options', () => {
    const result = validateCheckoutInput({ tier: 'enterprise', repoUrl: VALID_REPO });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /Invalid tier/);
    assert.match(result.error, /quick/);
    assert.match(result.error, /full/);
  });

  it('rejects missing repoUrl with 400', () => {
    const result = validateCheckoutInput({ tier: 'quick' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /GitHub repository URL/);
  });

  it('rejects empty string repoUrl with 400', () => {
    const result = validateCheckoutInput({ tier: 'quick', repoUrl: '' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /GitHub repository URL/);
  });

  it('rejects non-github repoUrl with 400', () => {
    const result = validateCheckoutInput({
      tier: 'quick',
      repoUrl: 'https://gitlab.com/foo/bar',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /GitHub repository URL/);
  });

  it('accepts a valid quick request', () => {
    const result = validateCheckoutInput({ tier: 'quick', repoUrl: VALID_REPO });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tierKey, 'quick');
    assert.strictEqual(result.tier, TIERS.quick);
    assert.strictEqual(result.repoUrl, VALID_REPO);
  });

  it('accepts a valid full request', () => {
    const result = validateCheckoutInput({ tier: 'full', repoUrl: VALID_REPO });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tierKey, 'full');
    assert.strictEqual(result.tier, TIERS.full);
  });
});

// ---------------------------------------------------------------------------
// buildStripeCheckoutParams — Stripe URL-encoded body shape
// ---------------------------------------------------------------------------
describe('buildStripeCheckoutParams', () => {
  it('encodes the Stripe-expected line item, metadata, and return URLs', () => {
    const params = buildStripeCheckoutParams({
      tier: TIERS.quick,
      tierKey: 'quick',
      repoUrl: VALID_REPO,
      baseUrl: 'https://gatetest.ai',
    });

    assert.strictEqual(params.get('payment_method_types[0]'), 'card');
    assert.strictEqual(params.get('mode'), 'payment');
    assert.strictEqual(
      params.get('payment_intent_data[capture_method]'),
      'manual',
      'manual capture is the whole pay-on-completion model'
    );

    // Line item — price, quantity, product metadata
    assert.strictEqual(
      params.get('line_items[0][price_data][currency]'),
      'usd'
    );
    assert.strictEqual(
      params.get('line_items[0][price_data][unit_amount]'),
      '2900',
      'quick scan is $29'
    );
    assert.strictEqual(params.get('line_items[0][quantity]'), '1');
    assert.strictEqual(
      params.get('line_items[0][price_data][product_data][name]'),
      'GateTest Quick Scan'
    );

    // Metadata duplicated on session + payment_intent so both surfaces see it
    assert.strictEqual(params.get('metadata[tier]'), 'quick');
    assert.strictEqual(params.get('metadata[repo_url]'), VALID_REPO);
    assert.strictEqual(
      params.get('payment_intent_data[metadata][tier]'),
      'quick'
    );
    assert.strictEqual(
      params.get('payment_intent_data[metadata][repo_url]'),
      VALID_REPO
    );

    // Return URLs — success must carry the session-id placeholder so the
    // success page can read the session back.
    assert.strictEqual(
      params.get('success_url'),
      'https://gatetest.ai/checkout/success?session_id={CHECKOUT_SESSION_ID}'
    );
    assert.strictEqual(
      params.get('cancel_url'),
      'https://gatetest.ai/checkout/cancel'
    );
  });

  it('honours a non-default baseUrl', () => {
    const params = buildStripeCheckoutParams({
      tier: TIERS.full,
      tierKey: 'full',
      repoUrl: VALID_REPO,
      baseUrl: 'https://staging.gatetest.ai',
    });
    assert.match(params.get('success_url'), /^https:\/\/staging\.gatetest\.ai\//);
    assert.match(params.get('cancel_url'), /^https:\/\/staging\.gatetest\.ai\//);
  });

  it('encodes Full Scan ($99) price correctly', () => {
    const params = buildStripeCheckoutParams({
      tier: TIERS.full,
      tierKey: 'full',
      repoUrl: VALID_REPO,
      baseUrl: 'https://gatetest.ai',
    });
    assert.strictEqual(
      params.get('line_items[0][price_data][unit_amount]'),
      '9900'
    );
  });
});

// ---------------------------------------------------------------------------
// createCheckoutSession — orchestrates validate → build → fetchImpl → map
// ---------------------------------------------------------------------------
describe('createCheckoutSession', () => {
  const BASE_ENV = {
    STRIPE_SECRET_KEY: 'sk_test_abc123',
    NEXT_PUBLIC_BASE_URL: 'https://gatetest.ai',
  };

  it('returns 503 when STRIPE_SECRET_KEY is unset', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' },
    });
    const result = await createCheckoutSession({
      input: { tier: 'quick', repoUrl: VALID_REPO },
      env: {},
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 503);
    assert.match(result.error, /not configured/);
    assert.strictEqual(calls.length, 0, 'must not call Stripe when not configured');
  });

  it('creates a session for a valid request, authorises with the secret, posts to Stripe', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' },
    });

    const result = await createCheckoutSession({
      input: { tier: 'quick', repoUrl: VALID_REPO },
      env: BASE_ENV,
      fetchImpl,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sessionId, 'cs_test_1');
    assert.strictEqual(result.checkoutUrl, 'https://checkout.stripe.com/cs_test_1');

    assert.strictEqual(calls.length, 1);
    const [call] = calls;
    assert.strictEqual(call.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.strictEqual(call.init.method, 'POST');
    assert.strictEqual(
      call.init.headers.Authorization,
      'Bearer sk_test_abc123',
      'Authorization header must carry the Stripe secret'
    );
    assert.strictEqual(
      call.init.headers['Content-Type'],
      'application/x-www-form-urlencoded'
    );

    // Body carries the right metadata + line item shape — we already unit-tested
    // buildStripeCheckoutParams, so here we just confirm it was plumbed through.
    const sent = new URLSearchParams(call.init.body);
    assert.strictEqual(sent.get('metadata[tier]'), 'quick');
    assert.strictEqual(sent.get('metadata[repo_url]'), VALID_REPO);
    assert.strictEqual(
      sent.get('payment_intent_data[capture_method]'),
      'manual'
    );
    assert.strictEqual(
      sent.get('line_items[0][price_data][unit_amount]'),
      '2900'
    );
    assert.match(
      sent.get('success_url'),
      /\?session_id=\{CHECKOUT_SESSION_ID\}$/
    );
  });

  it('returns 400 for invalid tier without calling Stripe', async () => {
    const { fetchImpl, calls } = makeMockFetch();
    const result = await createCheckoutSession({
      input: { tier: 'enterprise', repoUrl: VALID_REPO },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /Invalid tier/);
    assert.strictEqual(calls.length, 0, 'no Stripe call on validation failure');
  });

  it('returns 400 for missing repoUrl without calling Stripe', async () => {
    const { fetchImpl, calls } = makeMockFetch();
    const result = await createCheckoutSession({
      input: { tier: 'quick' },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /GitHub repository URL/);
    assert.strictEqual(calls.length, 0);
  });

  it('returns 400 for non-github repoUrl without calling Stripe', async () => {
    const { fetchImpl, calls } = makeMockFetch();
    const result = await createCheckoutSession({
      input: { tier: 'full', repoUrl: 'https://bitbucket.org/foo/bar' },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /GitHub repository URL/);
    assert.strictEqual(calls.length, 0);
  });

  it('returns 400 with Stripe-supplied message when Stripe returns an error body', async () => {
    const { fetchImpl } = makeMockFetch({
      ok: false,
      status: 402,
      body: {
        error: {
          message: 'Your card was declined.',
          type: 'card_error',
        },
      },
    });
    const result = await createCheckoutSession({
      input: { tier: 'quick', repoUrl: VALID_REPO },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.error, 'Your card was declined.');
  });

  it('returns 500 with a clean message when fetchImpl throws (network failure)', async () => {
    const { fetchImpl } = makeMockFetch({
      throws: new Error('ECONNREFUSED api.stripe.com'),
    });
    const result = await createCheckoutSession({
      input: { tier: 'quick', repoUrl: VALID_REPO },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 500);
    assert.match(result.error, /ECONNREFUSED/);
  });

  it('returns 500 when Stripe returns non-JSON / json() throws', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });
    const result = await createCheckoutSession({
      input: { tier: 'quick', repoUrl: VALID_REPO },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 500);
    assert.match(result.error, /Unexpected token/);
  });

  it('returns 500 on a non-ok HTTP response with no Stripe error shape', async () => {
    const { fetchImpl } = makeMockFetch({
      ok: false,
      status: 500,
      body: { unexpected: 'shape' },
    });
    const result = await createCheckoutSession({
      input: { tier: 'quick', repoUrl: VALID_REPO },
      env: BASE_ENV,
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 500);
    assert.match(result.error, /Stripe HTTP 500/);
  });

  it('falls back to https://gatetest.ai when NEXT_PUBLIC_BASE_URL is unset', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      body: { id: 'cs_test_2', url: 'https://checkout.stripe.com/cs_test_2' },
    });
    const result = await createCheckoutSession({
      input: { tier: 'full', repoUrl: VALID_REPO },
      env: { STRIPE_SECRET_KEY: 'sk_test_xyz' },
      fetchImpl,
    });
    assert.strictEqual(result.ok, true);
    const sent = new URLSearchParams(calls[0].init.body);
    assert.match(sent.get('success_url'), /^https:\/\/gatetest\.ai\//);
    assert.match(sent.get('cancel_url'), /^https:\/\/gatetest\.ai\//);
  });
});
