// Sentry server-side init for gatetest.ai.
//
// Runs in the Node.js runtime — every API route, every server
// component. Catches errors that the client-side SDK can't see
// (database errors, Stripe / Anthropic / GitHub API failures,
// scan-pipeline crashes). Loaded by instrumentation.ts at boot.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  sendDefaultPii: true,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Attach local variable values to stack frames — the single best
  // debugging signal Sentry offers on the server. Without this, a
  // 500 from /api/scan/fix gives you a stack but no idea what was
  // in scope. With it, you see the failing fixes array, the file
  // path, the issue text — everything.
  includeLocalVariables: true,

  enableLogs: true,

  // The /api/scan/run + /api/scan/fix routes can take 60-300s under
  // load. Sentry's default 2s shutdownTimeout would lose late events
  // when Vercel kills the function — bump to 5s.
  shutdownTimeout: 5000,

  release: process.env.SENTRY_RELEASE,
});
