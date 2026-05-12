// Sentry browser-runtime init for gatetest.ai.
//
// Replaces the older sentry.client.config.ts pattern (per
// docs.sentry.io/platforms/javascript/guides/nextjs/). Loaded
// automatically by Next.js when the app boots in the browser.
//
// PII contract: sendDefaultPii is ON because Sentry's distributed
// tracing + user attribution depend on it. Privacy-policy-wise this
// makes Sentry an explicit sub-processor of customer telemetry. The
// data set is request URL/headers + IP — never request bodies, never
// scan source code, never customer secrets. Bible Boss Rule #9
// implicitly authorised by Craig running `npx @sentry/wizard` directly.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  sendDefaultPii: true,

  // 100% in dev, 10% in prod — Sentry's recommended baseline.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Session Replay: 10% of all sessions, 100% of sessions that hit an
  // error. This is the most useful debugging signal we'll have when a
  // customer reports "the scan UI looked weird" — we can replay it.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  enableLogs: true,

  integrations: [
    Sentry.replayIntegration(),
  ],

  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
});

// Hook into App Router navigation transitions so client-side route
// changes show up as proper spans in Sentry tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
