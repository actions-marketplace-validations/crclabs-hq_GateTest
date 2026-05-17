/**
 * Per-IP rate limiter for GateTest's hot API endpoints.
 *
 * Architecture: in-process Map (token bucket, rolling window) as the
 * primary guard. Each Vercel cold-start begins with a fresh Map, so
 * burst protection is per-instance — that is good enough for HN-hug
 * defence where the concern is a single IP hammering a single warm
 * instance. A DB-backed variant can be layered in via `dbBackedFn`
 * when cross-instance counting is needed.
 *
 * Pure JS, CommonJS, Node stdlib only — testable with `node --test`
 * without any transform. Style matches surgical-fix.js.
 *
 * Five exports:
 *   1. RateLimiter   — class (windowMs, maxRequests, dbBackedFn?)
 *   2. extractClientIp  — pure header helper
 *   3. rateLimitResponse — standard 429 shape
 *   4. createLimiter — factory + guard function for Next.js routes
 *   5. PRESETS       — pre-configured limits for each route type
 */

"use strict";

// ─── 1. RateLimiter ──────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter backed by an in-process Map.
 *
 * @param {object} opts
 * @param {number} opts.windowMs      Rolling window length in milliseconds.
 * @param {number} opts.maxRequests   Maximum requests allowed per window.
 * @param {Function} [opts.dbBackedFn] Optional async (key, windowMs) =>
 *   Promise<{ count: number, ttl: number }> that returns the TOTAL count
 *   across all Vercel instances. When supplied the in-process count and
 *   the DB count are merged (max wins) so a single-instance burst that
 *   hasn't propagated to the DB yet is still caught immediately.
 * @param {Function} [opts.now]       Clock override for tests (default Date.now).
 */
class RateLimiter {
  constructor({ windowMs, maxRequests, dbBackedFn, now } = {}) {
    if (!windowMs || windowMs <= 0) throw new Error("windowMs must be a positive number");
    if (!maxRequests || maxRequests <= 0) throw new Error("maxRequests must be a positive number");

    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.dbBackedFn = dbBackedFn || null;
    this._now = now || (() => Date.now());

    // key → { count: number, windowStart: number }
    this._store = new Map();

    // Prune expired entries every windowMs to avoid unbounded Map growth
    // under sustained traffic (many distinct IPs). Skip in test environments
    // where `now` is injected and real timers are undesirable.
    if (!now) {
      this._pruneTimer = setInterval(() => this._prune(), windowMs);
      // Unref so the timer doesn't keep the Node process alive
      if (this._pruneTimer.unref) this._pruneTimer.unref();
    }
  }

  /**
   * Check whether `key` is within the rate limit.
   *
   * @param {string} key   Typically a client IP address.
   * @returns {Promise<{ allowed: boolean, remaining: number, resetMs: number, source: "memory"|"db"|"merged" }>}
   */
  async check(key) {
    const now = this._now();
    const { windowMs, maxRequests } = this;

    // ── In-process bucket ───────────────────────────────────────────────────
    let entry = this._store.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      // Window expired (or first request) — reset
      entry = { count: 0, windowStart: now };
    }
    entry.count += 1;
    this._store.set(key, entry);

    const memCount = entry.count;
    const memResetMs = Math.max(0, windowMs - (now - entry.windowStart));

    // Fast path: in-process says blocked — no DB call needed
    if (!this.dbBackedFn) {
      const remaining = Math.max(0, maxRequests - memCount);
      return {
        allowed: memCount <= maxRequests,
        remaining,
        resetMs: memResetMs,
        source: "memory",
      };
    }

    // ── DB-backed path (cross-instance) ─────────────────────────────────────
    let dbCount = 0;
    let dbTtl = windowMs;
    try {
      const dbResult = await this.dbBackedFn(key, windowMs);
      dbCount = (dbResult && typeof dbResult.count === "number") ? dbResult.count : 0;
      dbTtl = (dbResult && typeof dbResult.ttl === "number") ? dbResult.ttl : windowMs;
    } catch {
      // DB unavailable — fall back to in-process only rather than blocking all traffic
      const remaining = Math.max(0, maxRequests - memCount);
      return {
        allowed: memCount <= maxRequests,
        remaining,
        resetMs: memResetMs,
        source: "memory",
      };
    }

    // Merge: the higher of the two counts wins
    const mergedCount = Math.max(memCount, dbCount);
    const mergedResetMs = dbCount > memCount ? dbTtl : memResetMs;
    const remaining = Math.max(0, maxRequests - mergedCount);

    return {
      allowed: mergedCount <= maxRequests,
      remaining,
      resetMs: mergedResetMs,
      source: "merged",
    };
  }

  /**
   * Remove entries whose window has fully elapsed to prevent Map growth.
   */
  _prune() {
    const now = this._now();
    for (const [key, entry] of this._store.entries()) {
      if (now - entry.windowStart >= this.windowMs) {
        this._store.delete(key);
      }
    }
  }

  /**
   * Stop the background prune timer (useful in tests / teardown).
   */
  destroy() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
  }
}

// ─── 2. extractClientIp ──────────────────────────────────────────────────────

/**
 * Extract the real client IP from a NextRequest or IncomingMessage-shaped
 * object. Headers are checked in order of trust; the first non-empty value
 * wins. Strips ports and IPv6 brackets.
 *
 * Priority:
 *   x-forwarded-for   (first entry — set by load balancer/CDN, most reliable)
 *   x-real-ip         (nginx standard)
 *   cf-connecting-ip  (Cloudflare)
 *   x-vercel-forwarded-for
 *   fallback "unknown"
 *
 * @param {object} req  NextRequest or any object with a `.headers` property
 *                      (Map-like `.get()` or plain dict `.headers[name]`).
 * @returns {string}
 */
function extractClientIp(req) {
  if (!req || !req.headers) return "unknown";

  // Support both NextRequest.headers (Headers object with .get())
  // and plain node http.IncomingMessage (plain dict access).
  function getHeader(name) {
    if (typeof req.headers.get === "function") {
      return req.headers.get(name) || "";
    }
    return req.headers[name] || req.headers[name.toLowerCase()] || "";
  }

  const candidates = [
    getHeader("x-forwarded-for"),
    getHeader("x-real-ip"),
    getHeader("cf-connecting-ip"),
    getHeader("x-vercel-forwarded-for"),
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    // x-forwarded-for may be a comma-separated list; use the first entry
    const first = raw.split(",")[0].trim();
    if (!first) continue;
    return _normaliseIp(first);
  }

  return "unknown";
}

/**
 * Strip IPv6 brackets and ports from a raw IP string.
 * "[::1]:3000" → "::1"
 * "1.2.3.4:5678" → "1.2.3.4"
 * "::1" → "::1"
 *
 * @param {string} raw
 * @returns {string}
 */
function _normaliseIp(raw) {
  // IPv6 with brackets: [::1] or [::1]:port
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close !== -1) return raw.slice(1, close);
    return raw;
  }
  // IPv4 with port: 1.2.3.4:5678 — only strip if there's exactly one colon
  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount === 1) {
    return raw.split(":")[0];
  }
  // Plain IPv4 or bare IPv6 (multiple colons) — return as-is
  return raw;
}

// ─── 3. rateLimitResponse ────────────────────────────────────────────────────

/**
 * Build the standard 429 response payload from a RateLimiter.check() result.
 *
 * @param {{ remaining: number, resetMs: number }} result  check() return value
 * @param {number} maxRequests  The limiter's maxRequests for the Limit header
 * @returns {{ status: number, body: object, headers: object }}
 */
function rateLimitResponse(result, maxRequests) {
  const retryAfterSecs = Math.ceil(result.resetMs / 1000);
  const resetEpoch = Math.floor((Date.now() + result.resetMs) / 1000);

  return {
    status: 429,
    body: {
      error: "Too many requests",
      retryAfter: retryAfterSecs,
    },
    headers: {
      "Retry-After": String(retryAfterSecs),
      "X-RateLimit-Limit": String(maxRequests),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(resetEpoch),
    },
  };
}

// ─── 4. createLimiter ────────────────────────────────────────────────────────

/**
 * Convenience factory: creates a RateLimiter and returns it alongside a
 * `guard(req)` function shaped for Next.js route handlers.
 *
 * Usage in a route:
 *   const { guard } = createLimiter({ windowMs: 60_000, maxRequests: 10 });
 *   // inside POST(req):
 *   const limit = await guard(req);
 *   if (!limit.allowed) {
 *     return NextResponse.json(limit.body, { status: 429, headers: limit.headers });
 *   }
 *
 * @param {object} opts  Same as RateLimiter constructor (windowMs, maxRequests, dbBackedFn, now)
 * @returns {{ limiter: RateLimiter, guard: (req: object) => Promise<{ allowed: boolean, body?: object, headers?: object }> }}
 */
function createLimiter(opts) {
  const limiter = new RateLimiter(opts);
  const maxRequests = opts.maxRequests;

  async function guard(req) {
    const ip = extractClientIp(req);
    const result = await limiter.check(ip);
    if (result.allowed) {
      return { allowed: true, remaining: result.remaining, resetMs: result.resetMs };
    }
    const resp = rateLimitResponse(result, maxRequests);
    return { allowed: false, body: resp.body, headers: resp.headers, status: resp.status };
  }

  return { limiter, guard };
}

// ─── 5. PRESETS ──────────────────────────────────────────────────────────────

/**
 * Pre-configured rate-limit settings for each hot route.
 *
 * These are configuration objects, not live limiter instances. Each route
 * creates its own singleton limiter from these presets (module-level const)
 * so the state persists across requests within the same Vercel function
 * instance.
 *
 * Tuning rationale:
 *   checkout  — 5/min: each checkout creates a Stripe PaymentIntent (cost).
 *               An HN visitor refreshing 6 times in a minute is the outlier;
 *               a real customer never needs more than 1-2.
 *   scanRun   — 3/min: each scan runs up to 90 modules and makes multiple
 *               Gluecron / GitHub API calls. 3 is generous for legitimate use.
 *   scanFix   — 3/min: each fix call to Anthropic costs real $. 3/min/IP is
 *               already more than any human could usefully consume.
 *   publicApi — 30/min: covers authenticated v1 API consumers; the API-key
 *               layer adds per-key hourly limits on top.
 */
const PRESETS = {
  checkout: { windowMs: 60_000, maxRequests: 5 },
  scanRun: { windowMs: 60_000, maxRequests: 3 },
  scanFix: { windowMs: 60_000, maxRequests: 3 },
  publicApi: { windowMs: 60_000, maxRequests: 30 },
  // chat: 10 messages per minute per IP. Enough for a real conversation,
  // tight enough to bound Anthropic spend if abused.
  chat: { windowMs: 60_000, maxRequests: 10 },
};

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  RateLimiter,
  extractClientIp,
  rateLimitResponse,
  createLimiter,
  PRESETS,
};
