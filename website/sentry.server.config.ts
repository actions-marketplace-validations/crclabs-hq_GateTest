// Sentry server-side init for gatetest.ai.
//
// Runs in the Node.js runtime — every API route, every server
// component. Catches errors that the client-side SDK can't see
// (database errors, Stripe / Anthropic / GitHub API failures,
// scan-pipeline crashes). Loaded by instrumentation.ts at boot.

import * as Sentry from "@sentry/nextjs";

// Shared scrubber. CRITICAL: sendDefaultPii=true + includeLocalVariables=true
// without this would ship the customer's source code, prompts, repo URLs, and
// API keys to Sentry on any uncaught exception in /api/scan/fix.
// See website/app/lib/sentry-scrubber.js for the contract.
const { scrubEvent, scrubBreadcrumb } = require("@/app/lib/sentry-scrubber") as {
  scrubEvent: (event: unknown) => unknown;
  scrubBreadcrumb: (bc: unknown) => unknown;
};

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  sendDefaultPii: true,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Attach local variable values to stack frames — the single best
  // debugging signal Sentry offers on the server. Without this, a
  // 500 from /api/scan/fix gives you a stack but no idea what was
  // in scope. With it, you see the failing fixes array, the file
  // path, the issue text — everything.
  // GUARDED BY scrubEvent below: sensitive locals (body, prompt,
  // fileContent, messages, repoUrl, apiKey, token, secret, password)
  // are removed; oversize strings are truncated to a marker.
  includeLocalVariables: true,

  enableLogs: true,

  // The /api/scan/run + /api/scan/fix routes can take 60-300s under
  // load. Sentry's default 2s shutdownTimeout would lose late events
  // when Vercel kills the function — bump to 5s.
  shutdownTimeout: 5000,

  release: process.env.SENTRY_RELEASE,

  // Strip sensitive local variables, request bodies, cookies, and
  // sensitive headers BEFORE the event leaves the process. The scrubber
  // is type-erased (returns unknown) — the casts here match Sentry's
  // narrower per-hook event types without re-importing them.
  beforeSend(event) {
    try {
      return scrubEvent(event) as typeof event;
    } catch {
      // Scrubber must never block events; drop them if it throws.
      return null;
    }
  },

  beforeSendTransaction(event) {
    try {
      return scrubEvent(event) as typeof event;
    } catch {
      return null;
    }
  },

  beforeBreadcrumb(breadcrumb) {
    try {
      return scrubBreadcrumb(breadcrumb) as typeof breadcrumb;
    } catch {
      return null;
    }
  },
});
