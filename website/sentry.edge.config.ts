// Sentry edge-runtime init for gatetest.ai.
//
// Runs in the Vercel Edge runtime — middleware, edge route handlers.
// Separate runtime from Node.js so it needs its own SDK init even
// though our codebase doesn't currently put anything on the edge.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  sendDefaultPii: true,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  enableLogs: true,

  release: process.env.SENTRY_RELEASE,
});
