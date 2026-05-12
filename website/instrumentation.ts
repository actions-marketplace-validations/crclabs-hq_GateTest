// Next.js instrumentation entry-point.
//
// Loaded automatically by Next.js on every request before route
// handlers run. Sentry's Next.js SDK uses this hook to register its
// per-runtime init (server / edge). The actual init bodies live in
// sentry.server.config.ts / sentry.edge.config.ts; we re-import them
// here so Next.js sees them.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Re-export Sentry's request-error handler so server-side render
// failures get captured. Without this, server-component throws appear
// as 500s in the customer's browser with no stack trace anywhere.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
