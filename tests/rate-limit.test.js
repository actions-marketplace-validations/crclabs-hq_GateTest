"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  RateLimiter,
  extractClientIp,
  rateLimitResponse,
  createLimiter,
  PRESETS,
} = require("../lib/rate-limit");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake clock that starts at `base` and can be advanced by calling t.advance(ms). */
function fakeClock(base = 1_000_000) {
  let now = base;
  return {
    fn: () => now,
    advance: (ms) => { now += ms; },
    set: (abs) => { now = abs; },
  };
}

/** Build a minimal request-like object with the given headers. */
function makeReq(headers = {}) {
  return {
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null;
      },
    },
  };
}

// ─── RateLimiter — basic bucket behaviour ────────────────────────────────────

describe("RateLimiter — basic bucket behaviour", () => {
  test("first maxRequests calls are all allowed", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3, now: clock.fn });

    const r1 = await limiter.check("a");
    const r2 = await limiter.check("a");
    const r3 = await limiter.check("a");

    assert.equal(r1.allowed, true, "1st call allowed");
    assert.equal(r2.allowed, true, "2nd call allowed");
    assert.equal(r3.allowed, true, "3rd call allowed");
  });

  test("the (maxRequests+1)th call within the window is blocked", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3, now: clock.fn });

    await limiter.check("a");
    await limiter.check("a");
    await limiter.check("a");
    const r4 = await limiter.check("a"); // 4th → blocked

    assert.equal(r4.allowed, false, "4th call blocked");
    assert.equal(r4.remaining, 0, "remaining is 0 when blocked");
  });

  test("window reset allows requests again after windowMs elapses", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3, now: clock.fn });

    await limiter.check("a");
    await limiter.check("a");
    await limiter.check("a");
    const blocked = await limiter.check("a");
    assert.equal(blocked.allowed, false, "blocked before reset");

    // Advance past the window boundary
    clock.advance(1001);

    const afterReset = await limiter.check("a");
    assert.equal(afterReset.allowed, true, "allowed after window reset");
  });

  test("different keys do not interfere with each other", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2, now: clock.fn });

    // Exhaust key "x"
    await limiter.check("x");
    await limiter.check("x");
    const xBlocked = await limiter.check("x");
    assert.equal(xBlocked.allowed, false, "x is blocked");

    // Key "y" is completely unaffected
    const y1 = await limiter.check("y");
    assert.equal(y1.allowed, true, "y is still allowed");
  });

  test("remaining decrements correctly", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5, now: clock.fn });

    const r1 = await limiter.check("b");
    assert.equal(r1.remaining, 4, "remaining after 1st call");

    const r2 = await limiter.check("b");
    assert.equal(r2.remaining, 3, "remaining after 2nd call");

    const r3 = await limiter.check("b");
    assert.equal(r3.remaining, 2, "remaining after 3rd call");
  });

  test("resetMs is positive while blocked, approximately 0 at reset boundary", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1, now: clock.fn });

    const r1 = await limiter.check("c");
    assert.equal(r1.allowed, true);

    const r2 = await limiter.check("c"); // blocked
    assert.equal(r2.allowed, false);
    assert.ok(r2.resetMs > 0, "resetMs > 0 while blocked");

    // Advance to just before the window end
    clock.advance(999);
    const r3 = await limiter.check("c"); // still blocked, still in same window
    assert.equal(r3.allowed, false);
    assert.ok(r3.resetMs <= 2, "resetMs is tiny right before window expires");
  });
});

// ─── extractClientIp ─────────────────────────────────────────────────────────

describe("extractClientIp", () => {
  test("returns first entry from x-forwarded-for", () => {
    const req = makeReq({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" });
    assert.equal(extractClientIp(req), "1.2.3.4");
  });

  test("falls back through header priority order", () => {
    // Only x-real-ip is present
    const req = makeReq({ "x-real-ip": "10.0.0.1" });
    assert.equal(extractClientIp(req), "10.0.0.1");

    // Only cf-connecting-ip is present
    const req2 = makeReq({ "cf-connecting-ip": "203.0.113.5" });
    assert.equal(extractClientIp(req2), "203.0.113.5");

    // Only x-vercel-forwarded-for is present
    const req3 = makeReq({ "x-vercel-forwarded-for": "172.16.0.1" });
    assert.equal(extractClientIp(req3), "172.16.0.1");

    // Nothing is present → "unknown"
    const req4 = makeReq({});
    assert.equal(extractClientIp(req4), "unknown");
  });

  test("x-forwarded-for takes priority over x-real-ip when both present", () => {
    const req = makeReq({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "9.9.9.9",
    });
    assert.equal(extractClientIp(req), "1.2.3.4");
  });

  test("strips ports from IPv4 addresses", () => {
    const req = makeReq({ "x-forwarded-for": "1.2.3.4:56789" });
    assert.equal(extractClientIp(req), "1.2.3.4");
  });

  test("strips IPv6 brackets", () => {
    const req = makeReq({ "x-forwarded-for": "[::1]" });
    assert.equal(extractClientIp(req), "::1");
  });

  test("strips IPv6 brackets with port", () => {
    const req = makeReq({ "x-forwarded-for": "[::1]:3000" });
    assert.equal(extractClientIp(req), "::1");
  });
});

// ─── rateLimitResponse ───────────────────────────────────────────────────────

describe("rateLimitResponse", () => {
  test("returns the correct HTTP 429 shape", () => {
    const result = { remaining: 0, resetMs: 45_000 };
    const resp = rateLimitResponse(result, 10);

    assert.equal(resp.status, 429);
    assert.equal(resp.body.error, "Too many requests");
    assert.equal(resp.body.retryAfter, 45); // ceil(45000 / 1000)

    assert.equal(resp.headers["Retry-After"], "45");
    assert.equal(resp.headers["X-RateLimit-Limit"], "10");
    assert.equal(resp.headers["X-RateLimit-Remaining"], "0");

    // X-RateLimit-Reset must be a Unix epoch (10 digits)
    const reset = Number(resp.headers["X-RateLimit-Reset"]);
    assert.ok(reset > 1_000_000_000, "reset is a Unix epoch");
    assert.ok(reset < 10_000_000_000, "reset is a reasonable Unix epoch");
  });

  test("retryAfter rounds UP via Math.ceil", () => {
    const result = { remaining: 0, resetMs: 1 }; // 1ms → 1s (ceil)
    const resp = rateLimitResponse(result, 5);
    assert.equal(resp.body.retryAfter, 1);
    assert.equal(resp.headers["Retry-After"], "1");
  });
});

// ─── createLimiter ───────────────────────────────────────────────────────────

describe("createLimiter", () => {
  test("guard returns allowed:true with correct shape when under limit", async () => {
    const clock = fakeClock();
    const { guard } = createLimiter({ windowMs: 60_000, maxRequests: 5, now: clock.fn });
    const req = makeReq({ "x-forwarded-for": "1.2.3.4" });

    const result = await guard(req);
    assert.equal(result.allowed, true);
    assert.equal(typeof result.remaining, "number");
    assert.ok(result.remaining >= 0);
  });

  test("guard returns allowed:false with body+headers when limit exceeded", async () => {
    const clock = fakeClock();
    const { guard } = createLimiter({ windowMs: 60_000, maxRequests: 2, now: clock.fn });
    const req = makeReq({ "x-forwarded-for": "1.2.3.4" });

    await guard(req);
    await guard(req);
    const blocked = await guard(req); // 3rd → blocked

    assert.equal(blocked.allowed, false);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body && blocked.body.error === "Too many requests");
    assert.ok(blocked.headers && blocked.headers["Retry-After"]);
    assert.ok(blocked.headers["X-RateLimit-Limit"] === "2");
  });
});

// ─── PRESETS sanity ──────────────────────────────────────────────────────────

describe("PRESETS", () => {
  test("all four presets exist with valid positive fields", () => {
    const required = ["checkout", "scanRun", "scanFix", "publicApi"];
    for (const key of required) {
      assert.ok(PRESETS[key], `${key} preset missing`);
      assert.ok(PRESETS[key].windowMs > 0, `${key}.windowMs must be positive`);
      assert.ok(PRESETS[key].maxRequests > 0, `${key}.maxRequests must be positive`);
    }
  });

  test("scanRun and scanFix are the most restrictive (protect Anthropic budget)", () => {
    // scanRun and scanFix are the costliest routes (Anthropic + GitHub API calls).
    // Both are capped at 3/min — lower than checkout (5/min) or publicApi (30/min).
    assert.ok(
      PRESETS.scanRun.maxRequests <= PRESETS.checkout.maxRequests,
      "scanRun should be <= checkout"
    );
    assert.ok(
      PRESETS.scanFix.maxRequests <= PRESETS.checkout.maxRequests,
      "scanFix should be <= checkout"
    );
  });

  test("publicApi is the most permissive", () => {
    const all = Object.values(PRESETS).map((p) => p.maxRequests);
    assert.equal(
      Math.max(...all),
      PRESETS.publicApi.maxRequests,
      "publicApi should have the highest maxRequests"
    );
  });
});
