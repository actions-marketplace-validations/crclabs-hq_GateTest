import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  serverExternalPackages: ["ssh2"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com", // web-headers-ok — unsafe-eval required by Stripe.js (https://stripe.com/docs/security/guide#content-security-policy)
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: blob:",
              "font-src 'self' data:",
              // Sentry endpoints — *.ingest.sentry.io for the browser
              // SDK to POST events; *.sentry.io covers session-replay
              // probes. The /monitoring tunnelRoute is same-origin so
              // it's already covered by 'self' here.
              "connect-src 'self' https://api.stripe.com https://api.anthropic.com https://api.github.com https://github.com https://*.ingest.sentry.io https://*.sentry.io",
              "frame-src https://js.stripe.com https://hooks.stripe.com",
              "frame-ancestors 'self'",
              "form-action 'self' https://checkout.stripe.com",
              "base-uri 'self'",
              "object-src 'none'",
              "upgrade-insecure-requests",
              // Sentry's session-replay worker + page-load profiling
              // need worker-src. blob: required for inline workers.
              "worker-src 'self' blob:",
            ].join("; "),
          },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

// Sentry build-time options — canonical set per
// docs.sentry.io/platforms/javascript/guides/nextjs/.
//
// Org / project come from env so the same config works in CI + local.
// Without SENTRY_AUTH_TOKEN the build still succeeds; sourcemap upload
// and release tagging just don't happen (errors still capture, just
// unsymbolicated).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload a wider set of source files so production stack traces
  // resolve back to readable code, not minified bundles.
  widenClientFileUpload: true,

  // Proxy Sentry events through gatetest.ai/monitoring to bypass
  // ad-blockers that filter *.ingest.sentry.io. Same-origin route, no
  // CSP relaxation needed beyond the existing connect-src 'self'.
  tunnelRoute: "/monitoring",

  // Quiet build output unless we're in CI (where the logs are useful).
  silent: !process.env.CI,

  // Sourcemap delivery — Sentry uploads them via authToken so they
  // resolve stack traces in their UI, but the public bundle doesn't
  // ship the maps. SDK 10 controls this through the sourcemaps block.
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Note: disableLogger removed — deprecated under Turbopack (which we
  // use). Webpack-only equivalent is webpack.treeshake.removeDebugLogging
  // and we don't need it.
});
