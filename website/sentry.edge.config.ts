// Sentry edge-runtime init for gatetest.ai.
//
// Runs in the Vercel Edge runtime — middleware, edge route handlers.
// Separate runtime from Node.js so it needs its own SDK init even
// though our codebase doesn't currently put anything on the edge.

import * as Sentry from "@sentry/nextjs";

// Shared scrubber — see sentry.server.config.ts for full contract.
const { scrubEvent, scrubBreadcrumb } = require("@/app/lib/sentry-scrubber") as {
  scrubEvent: (event: unknown) => unknown;
  scrubBreadcrumb: (bc: unknown) => unknown;
};

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  sendDefaultPii: true,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  enableLogs: true,

  release: process.env.SENTRY_RELEASE,

  beforeSend(event) {
    try {
      return scrubEvent(event) as typeof event;
    } catch {
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
