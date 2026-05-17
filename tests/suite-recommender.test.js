'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classify } = require('../website/app/lib/url-stack-detector.js');
const { recommendForProfile } = require('../website/app/lib/suite-recommender.js');

// ── url-stack-detector.classify ──────────────────────────────────────

function probe(opts) {
  return { status: 200, headers: {}, body: '', ...opts };
}

test('classify — WordPress markup is detected', () => {
  const r = classify(probe({ body: '<link rel="https://api.w.org/" href="/wp-json/" /><script src="/wp-content/themes/x.js"></script>' }));
  assert.equal(r.cms, 'WordPress');
  assert.equal(r.language, 'PHP');
});

test('classify — Next.js __NEXT_DATA__ detected', () => {
  const r = classify(probe({ body: '<script id="__NEXT_DATA__" type="application/json">{}</script>' }));
  assert.equal(r.framework, 'Next.js');
});

test('classify — Nuxt __NUXT__ detected', () => {
  const r = classify(probe({ body: '<script>window.__NUXT__ = {};</script>' }));
  assert.equal(r.framework, 'Nuxt');
});

test('classify — Shopify storefront detected', () => {
  const r = classify(probe({ body: '<script src="https://cdn.shopify.com/x.js"></script>' }));
  assert.equal(r.cms, 'Shopify');
});

test('classify — Cloudflare CDN detected via cf-ray header', () => {
  const r = classify(probe({ headers: { 'cf-ray': '8c0abcd1234' } }));
  assert.equal(r.cdn, 'Cloudflare');
});

test('classify — Vercel detected via x-vercel-id', () => {
  const r = classify(probe({ headers: { 'x-vercel-id': 'syd1::abc-xyz' } }));
  assert.equal(r.cdn, 'Vercel');
});

test('classify — nginx server header', () => {
  const r = classify(probe({ headers: { server: 'nginx/1.21.6' } }));
  assert.equal(r.server, 'nginx');
});

test('classify — x-powered-by PHP infers language', () => {
  const r = classify(probe({ headers: { 'x-powered-by': 'PHP/8.2.0' } }));
  assert.equal(r.language, 'PHP');
});

test('classify — hasAdminPath when /wp-admin referenced', () => {
  const r = classify(probe({ body: '<a href="/wp-admin">Login</a>' }));
  assert.equal(r.hasAdminPath, true);
});

test('classify — hasApi when /api/ in HTML', () => {
  const r = classify(probe({ body: '<script>fetch("/api/users")</script>' }));
  assert.equal(r.hasApi, true);
});

test('classify — graphql endpoint flagged as API', () => {
  const r = classify(probe({ body: '<script>fetch("/graphql")</script>' }));
  assert.equal(r.hasApi, true);
});

test('classify — e-commerce surface detected via "add to cart"', () => {
  const r = classify(probe({ body: '<button class="add-to-cart">Buy</button>' }));
  assert.equal(r.hasEcommerce, true);
});

test('classify — static / no-framework site flagged', () => {
  const r = classify(probe({ body: '<html><body><h1>Hello</h1></body></html>' }));
  assert.equal(r.isStatic, true);
});

test('classify — hints array contains human-readable summaries', () => {
  const r = classify(probe({
    headers: { server: 'cloudflare' },
    body: '<script id="__NEXT_DATA__"></script>',
  }));
  assert.ok(r.hints.some((h) => /Next.js/i.test(h)));
  assert.ok(r.hints.some((h) => /Cloudflare/i.test(h)));
});

// ── suite-recommender.recommendForProfile ────────────────────────────

test('recommendForProfile — WordPress picks wp suite', () => {
  const r = recommendForProfile({ profile: { cms: 'WordPress', framework: null, language: 'PHP' } });
  assert.equal(r.suite, 'wp');
  assert.ok(r.emphasis.includes('wpExposedFiles'));
  assert.ok(r.reasoning.some((s) => /WordPress/i.test(s)));
});

test('recommendForProfile — non-WP picks generic web suite', () => {
  const r = recommendForProfile({ profile: { framework: 'Next.js' } });
  assert.equal(r.suite, 'web');
});

test('recommendForProfile — e-commerce bumps tier to full', () => {
  const r = recommendForProfile({ profile: { hasEcommerce: true } });
  assert.equal(r.tier, 'full');
  assert.ok(r.emphasis.includes('tlsSecurity'));
});

test('recommendForProfile — admin path bumps from quick to full', () => {
  const r = recommendForProfile({ profile: { hasAdminPath: true } });
  assert.equal(r.tier, 'full');
});

test('recommendForProfile — API endpoints bump tier', () => {
  const r = recommendForProfile({ profile: { hasApi: true } });
  assert.equal(r.tier, 'full');
});

test('recommendForProfile — 3+ surfaces escalates to Nuclear', () => {
  const r = recommendForProfile({ profile: {
    cms: 'WordPress',
    hasEcommerce: true,
    hasAdminPath: true,
    hasApi: true,
  } });
  assert.equal(r.tier, 'nuclear');
  assert.ok(r.reasoning.some((s) => /Nuclear/i.test(s)));
});

test('recommendForProfile — Next.js sets runtimeErrors emphasis', () => {
  const r = recommendForProfile({ profile: { framework: 'Next.js' } });
  assert.ok(r.emphasis.includes('runtimeErrors'));
});

test('recommendForProfile — static site recommendation includes seo + links', () => {
  const r = recommendForProfile({ profile: { isStatic: true } });
  assert.ok(r.emphasis.includes('seo'));
  assert.ok(r.emphasis.includes('links'));
});

test('recommendForProfile — Cloudflare reasoning mentions header location', () => {
  const r = recommendForProfile({ profile: { cdn: 'Cloudflare' } });
  assert.ok(r.reasoning.some((s) => /Cloudflare|origin/i.test(s)));
});

test('recommendForProfile — WP at quick tier uses wp_health CTA', () => {
  const r = recommendForProfile({ profile: { cms: 'WordPress' } });
  assert.equal(r.tier, 'quick');
  assert.equal(r.ctaUrl, '/api/checkout?tier=wp_health');
});

test('recommendForProfile — default fallback emphasis populated', () => {
  const r = recommendForProfile({ profile: {} });
  assert.ok(r.emphasis.length >= 3);
});

test('recommendForProfile — output shape is stable', () => {
  const r = recommendForProfile({ profile: { framework: 'React' } });
  assert.ok(['web', 'wp'].includes(r.suite));
  assert.ok(['quick', 'full', 'scan_fix', 'nuclear'].includes(r.tier));
  assert.ok(typeof r.priceUsd === 'number');
  assert.ok(typeof r.ctaUrl === 'string');
  assert.ok(Array.isArray(r.emphasis));
  assert.ok(Array.isArray(r.reasoning));
});
