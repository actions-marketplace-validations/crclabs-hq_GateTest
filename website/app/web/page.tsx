// Generic web URL scan landing — lives at /web. Twin of /wp but
// for any public site (not just WordPress).
//
// Voice: plain English for non-technical site owners + technical voice
// where it differentiates (live browser checks, hydration mismatch
// detection, real CSP violation capture).

import Link from "next/link";

export const metadata = {
  title: "GateTest — Live Website Health Check, Security + Runtime Audit",
  description:
    "Paste any URL. We run live HTTPS + header + cookie probes AND open the site in a real headless browser to catch JavaScript errors, broken assets, CSP violations and hydration mismatches in the actual page load. Plain-English report with a 0-100 health score.",
};

export default function WebLanding() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="px-6 py-20 max-w-4xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-sm font-medium mb-8">
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" aria-hidden />
          New — works on any website (not just WordPress)
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
          What&apos;s actually wrong
          <br />
          <span className="text-accent">with your website?</span>
        </h1>

        <p className="text-lg sm:text-xl text-muted max-w-2xl mx-auto mb-10 leading-relaxed">
          Most scanners only check what your server <em>says</em> it does.
          We open your site in a real browser and watch what actually
          happens. JavaScript errors. Broken hydration. CSP violations.
          Mixed-content. Network failures. Plus all the usual hardening
          checks. One 0-100 score. Plain-English fixes.
        </p>

        <form
          action="/api/web/scan"
          method="POST"
          className="flex flex-col sm:flex-row items-stretch justify-center gap-3 max-w-xl mx-auto mb-12"
        >
          <input
            type="url"
            name="url"
            required
            placeholder="https://yoursite.com"
            className="flex-1 px-5 py-4 rounded-xl border border-border bg-background-alt text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent text-lg"
          />
          <button
            type="submit"
            className="px-8 py-4 rounded-xl bg-accent text-white font-semibold text-lg hover:bg-accent-hover transition-colors"
          >
            Scan my site
          </button>
        </form>

        <p className="text-sm text-muted">
          Free preview — top 3 root-cause issues and your health score.
          No signup, no install, no admin access needed.
        </p>
      </section>

      <section className="px-6 py-16 max-w-5xl mx-auto border-t border-border">
        <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">
          What we look for
        </h2>
        <p className="text-center text-muted mb-12 max-w-2xl mx-auto">
          We don&apos;t just check what your server <em>claims</em>. We open
          your site in a real Chromium and watch what actually breaks.
        </p>

        <div className="grid sm:grid-cols-2 gap-6">
          {PAINKILLERS.map(({ title, pain, what }) => (
            <div
              key={title}
              className="p-6 rounded-2xl bg-background-alt border border-border"
            >
              <h3 className="font-bold text-lg mb-2">{title}</h3>
              <p className="text-sm text-danger mb-3">
                <span className="font-semibold">Why it matters: </span>
                {pain}
              </p>
              <p className="text-sm text-muted">
                <span className="font-semibold text-foreground">What we check: </span>
                {what}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-16 max-w-5xl mx-auto border-t border-border">
        <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">
          Cluster-first, noise-last
        </h2>
        <p className="text-center text-muted mb-8 max-w-3xl mx-auto">
          A typical site scan returns 800-1000 raw findings — mostly the
          same root cause repeated across pages. We collapse them into
          ~20 root-cause clusters ranked highest-signal first, score the
          site 0-100, and tell you the three things that move the needle
          most. The other 977 findings are the same fix repeated — you
          shouldn&apos;t pay (in attention or money) for noise.
        </p>
      </section>

      <section className="px-6 py-16 max-w-5xl mx-auto border-t border-border">
        <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">
          Honest pricing
        </h2>
        <p className="text-center text-muted mb-12 max-w-2xl mx-auto">
          Pay per scan. No subscription required for the one-shot.
        </p>

        <div className="grid sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`p-6 rounded-2xl border ${
                tier.highlighted
                  ? "border-accent bg-accent/5 ring-2 ring-accent/20"
                  : "border-border bg-background-alt"
              }`}
            >
              <h3 className="font-bold text-xl mb-1">{tier.name}</h3>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-3xl font-bold">{tier.price}</span>
                <span className="text-sm text-muted">/ {tier.cadence}</span>
              </div>
              <ul className="space-y-2 text-sm mt-4">
                {tier.includes.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <span className="text-accent" aria-hidden>✓</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-16 max-w-3xl mx-auto border-t border-border text-center">
        <h2 className="text-3xl font-bold mb-6">Ready when you are.</h2>
        <Link
          href="#top"
          className="inline-block px-8 py-4 rounded-xl bg-accent text-white font-semibold text-lg hover:bg-accent-hover transition-colors"
        >
          Scan my site
        </Link>
        <p className="text-xs text-muted mt-6">
          Same engine as the developer <Link href="/" className="text-accent hover:underline">GateTest</Link> CLI —
          90+ static checks plus live headless-browser runtime capture. WordPress
          owner? <Link href="/wp" className="text-accent hover:underline">WordPress-specific scan here</Link>.
        </p>
      </section>
    </main>
  );
}

const PAINKILLERS = [
  {
    title: "Live JavaScript errors",
    pain: "Your visitors see a half-loaded page. Search and forms silently break. Static probes can't see this — only a real browser can.",
    what: "Uncaught page errors, unhandled promise rejections, console.error spam during initial load.",
  },
  {
    title: "Hydration mismatches",
    pain: "React/Next.js/Vue/Nuxt sites can render server HTML that doesn't match the client tree. Users see flicker or a blank UI for seconds before interactivity arrives.",
    what: "Console output captured by a real Chromium for hydration / SSR-mismatch / minified React error markers.",
  },
  {
    title: "Broken or blocked network resources",
    pain: "A 404 on a critical script kills features silently. A blocked CDN call breaks search or checkout. Real users feel it; uptime monitors don't.",
    what: "Every script, image, font, stylesheet, and fetch() call that fires during page load — fail status or DNS / refused / timeout reasons.",
  },
  {
    title: "Content Security Policy violations",
    pain: "A live browser blocked your own scripts or third-party assets. Either your CSP is too strict for your own code, or an analytics provider is breaking.",
    what: "Every CSP report-uri-style violation reported during the page session.",
  },
  {
    title: "Mixed content (HTTPS+HTTP)",
    pain: "Modern browsers refuse to load HTTP assets from an HTTPS page. Images vanish, scripts fail, the lock icon disappears.",
    what: "Every HTTP asset URL embedded in your HTTPS page.",
  },
  {
    title: "Security headers missing",
    pain: "Modern browsers stop XSS, clickjacking, and cookie theft — but only if your site asks them to. Most don't.",
    what: "CSP, X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.",
  },
  {
    title: "HTTPS / TLS misconfiguration",
    pain: "Wrong cert, expired cert, weak protocol — browsers show a warning page and visitors bounce immediately.",
    what: "Cert chain validity, modern TLS support, mixed-content surface, HSTS preload eligibility.",
  },
  {
    title: "Cookie hardening missing",
    pain: "Session cookies without Secure / HttpOnly / SameSite are a session-takeover vector for any XSS or CSRF that lands.",
    what: "Every Set-Cookie header captured during the scan — flagged for missing protections.",
  },
];

const TIERS = [
  {
    name: "Free Preview",
    price: "$0",
    cadence: "no signup",
    includes: [
      "Top 3 highest-signal issues",
      "Health Score (0-100) + letter grade",
      "Plain-English summary",
      "Best for: deciding whether to dig deeper",
    ],
  },
  {
    name: "Quick Scan",
    price: "$29",
    cadence: "one-shot",
    highlighted: true,
    includes: [
      "Full scan — every clustered issue",
      "Per-cluster fix instructions",
      "Live browser runtime capture",
      "Health Score + per-rule deductions",
      "Best for: post-deploy, post-redesign, quarterly audits",
    ],
  },
  {
    name: "Continuous",
    price: "$49",
    cadence: "per month",
    includes: [
      "Scan on every push (if GitHub-connected)",
      "Weekly scheduled scan",
      "Email alert on score regression",
      "Best for: production sites with real revenue",
    ],
  },
];
