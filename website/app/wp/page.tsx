// WordPress side product landing page — lives at /wp until wp.gatetest.ai
// subdomain DNS lands (Boss Rule #4 — Craig).
//
// Voice: plain English for non-technical WordPress owners. No "module fired"
// or "AST traversal." Findings read like a friend telling them what's wrong.

import Link from "next/link";
import { UrlScanFlow } from "@/app/components/UrlScanFlow";

export const metadata = {
  title: "GateTest for WordPress — Health Check, Security Audit, Auto-Fix",
  description:
    "Scan your WordPress site in 60 seconds. Find malware exposure, leaked credentials, security misconfigurations, and slow pages. Plain-language report. $19 one-shot, no subscription.",
};

export default function WordPressLanding() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="px-6 py-20 max-w-4xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-sm font-medium mb-8">
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" aria-hidden />
          New — built for WordPress owners
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
          Find out what&apos;s wrong with your WordPress site.
          <br />
          <span className="text-accent">In 60 seconds.</span>
        </h1>

        <p className="text-lg sm:text-xl text-muted max-w-2xl mx-auto mb-10 leading-relaxed">
          Paste your URL. We&apos;ll check 30+ things attackers look for first —
          leaked database backups, exposed config files, brute-force-friendly
          login pages, slow pages, accessibility complaints waiting to happen.
          Plain-English report you can act on yourself or hand to your developer.
        </p>

        <UrlScanFlow suite="wp" endpoint="/api/wp/scan" brandLabel="WordPress scan" />
      </section>

      <section className="px-6 py-16 max-w-5xl mx-auto border-t border-border">
        <h2 className="text-3xl sm:text-4xl font-bold text-center mb-12">
          What we look for
        </h2>

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
          Honest pricing
        </h2>
        <p className="text-center text-muted mb-12 max-w-2xl mx-auto">
          Pay per scan, not per month. Most owners run a scan after every
          plugin update or once a quarter — that&apos;s how the pricing was designed.
        </p>

        <div className="grid sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`p-6 rounded-2xl border ${
                tier.highlighted ? "border-accent bg-accent/5" : "border-border bg-background-alt"
              }`}
            >
              <h3 className="font-bold text-lg mb-1">{tier.name}</h3>
              <p className="text-3xl font-bold mb-1">{tier.price}</p>
              <p className="text-xs text-muted mb-4">{tier.cadence}</p>
              <ul className="text-sm space-y-2 mb-6">
                {tier.includes.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <span className="text-accent mt-0.5">✓</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted mt-8">
          Pricing structure pending Stripe setup — see your developer if you need
          immediate access. Pre-launch, every scan is free during the soft-launch
          window.
        </p>
      </section>

      <section className="px-6 py-16 max-w-3xl mx-auto border-t border-border">
        <h2 className="text-3xl sm:text-4xl font-bold mb-6">
          What we DON&apos;T do
        </h2>
        <p className="text-muted mb-6 leading-relaxed">
          Three things we tell you up front — because nothing kills trust faster
          than discovering hidden limitations after you&apos;ve paid.
        </p>
        <ul className="space-y-4">
          <li className="flex items-start gap-3">
            <span className="text-warning text-xl">!</span>
            <div>
              <p className="font-semibold">We don&apos;t remove malware.</p>
              <p className="text-sm text-muted">
                We tell you what&apos;s exposed, where, and how to fix it. Cleanup is
                a manual step. If your site is actively compromised, we&apos;ll point
                you at Sucuri or Wordfence for the cleanup.
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-warning text-xl">!</span>
            <div>
              <p className="font-semibold">We don&apos;t take backups for you.</p>
              <p className="text-sm text-muted">
                We tell you if you don&apos;t have one. UpdraftPlus is free and we&apos;ll
                walk you through setup if needed.
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-warning text-xl">!</span>
            <div>
              <p className="font-semibold">We don&apos;t block attackers in real time.</p>
              <p className="text-sm text-muted">
                That&apos;s a firewall — Wordfence and Cloudflare are good at it.
                We&apos;re the audit that tells you whether your firewall is doing
                its job.
              </p>
            </div>
          </li>
        </ul>
      </section>

      <section className="px-6 py-16 max-w-3xl mx-auto border-t border-border text-center">
        <h2 className="text-3xl font-bold mb-6">Ready when you are.</h2>
        <Link
          href="#top"
          className="inline-block px-8 py-4 rounded-xl bg-accent text-white font-semibold text-lg hover:bg-accent-hover transition-colors"
        >
          Scan my WordPress site
        </Link>
        <p className="text-xs text-muted mt-6">
          Built on the <Link href="/" className="text-accent hover:underline">GateTest</Link> engine
          — the same 94-module QA gate developers use on their codebases.
        </p>
      </section>
    </main>
  );
}

const PAINKILLERS = [
  {
    title: "Leaked database credentials",
    pain: "If your `wp-config.php.bak` or `.git` folder is publicly readable, any visitor can read your database password and download your entire site.",
    what: "wp-config.php.bak, wp-config.php.swp, .git/HEAD, .env, debug.log, error_log, SQL backups in /uploads/.",
  },
  {
    title: "WordPress version exposure",
    pain: "Attackers match your WordPress version against known CVEs. Hiding the version cuts targeted attacks dramatically.",
    what: "readme.html, meta generator tag, RSS feed <generator>, license.txt, CSS/JS ver= query strings.",
  },
  {
    title: "XML-RPC weapon turret",
    pain: "99% of sites don't use xmlrpc.php — but if it's enabled, attackers use it as a DDoS reflector against other sites, or to brute-force your password 1000x faster.",
    what: "Whether /xmlrpc.php is reachable, whether pingback.ping is enabled (the DDoS hook).",
  },
  {
    title: "Brute-force-friendly admin",
    pain: "If /wp-admin and /wp-login.php have no rate limit, attackers try millions of credentials per day. A weak admin password is now a question of when, not if.",
    what: "Whether the login page is reachable from the open internet, whether there's a WAF in front, whether usernames are enumerable.",
  },
  {
    title: "Security headers missing",
    pain: "Modern browsers protect against XSS and clickjacking — but only if your site asks them to. Most WordPress sites don't.",
    what: "Content-Security-Policy, X-Frame-Options, Strict-Transport-Security, Referrer-Policy, Permissions-Policy.",
  },
  {
    title: "Accessibility / ADA compliance",
    pain: "WCAG complaints can become $5K-$100K legal exposure. Every month brings new ADA-compliance lawsuits against e-commerce sites.",
    what: "Missing alt text, contrast ratios, keyboard navigability, heading hierarchy, ARIA landmarks.",
  },
  {
    title: "Performance / Core Web Vitals",
    pain: "Google ranks slow sites lower. A page that loads in 5 seconds instead of 2 measurably loses traffic and ad revenue.",
    what: "Largest Contentful Paint, Cumulative Layout Shift, Time to First Byte, render-blocking assets.",
  },
  {
    title: "Broken links + dead images",
    pain: "Broken images crater conversion rates. Broken outbound links damage SEO authority.",
    what: "Every <a href> and <img src> on your homepage and 10 deepest-linked pages.",
  },
];

const TIERS = [
  {
    name: "Free Preview",
    price: "$0",
    cadence: "no signup",
    includes: [
      "Top 3 most urgent issues",
      "Plain-language summary",
      "Best for: deciding whether to dig deeper",
    ],
  },
  {
    name: "Health Check",
    price: "$19",
    cadence: "one-shot",
    highlighted: true,
    includes: [
      "Full scan — all 30+ checks",
      "Plain-language report you can share",
      "Step-by-step fix instructions",
      "Best for: post-plugin-update, quarterly checkups",
    ],
  },
  {
    name: "Continuous",
    price: "$19",
    cadence: "per month",
    includes: [
      "Weekly scan on schedule",
      "Email alerts on new CVEs affecting your stack",
      "Side-by-side diff when something changes",
      "Best for: production sites with real revenue",
    ],
  },
];
