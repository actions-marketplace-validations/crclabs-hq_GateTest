const scanners = [
  { name: "Dependency CVE Watch", frequency: "Continuous", description: "Monitors npm/pip/cargo advisories for new vulnerabilities in your deps" },
  { name: "SSL Certificate Monitor", frequency: "Continuous", description: "Tracks certificate expiry dates, alerts 30 days before" },
  { name: "Uptime Monitor", frequency: "Every 60s", description: "Pings all endpoints, alerts on downtime within seconds" },
  { name: "Error Rate Monitor", frequency: "Continuous", description: "Alerts if error rate exceeds 0.1% over any 5-minute window" },
  { name: "Performance Baseline", frequency: "Hourly", description: "Collects Core Web Vitals, alerts on regression immediately" },
  { name: "Security Header Audit", frequency: "Hourly", description: "Verifies CSP, HSTS, X-Frame-Options haven't been stripped" },
  { name: "Lighthouse Full Audit", frequency: "Daily", description: "Performance, accessibility, SEO, and best practices scoring" },
  { name: "Broken Link Crawl", frequency: "Daily", description: "Crawls your entire site for 404s and broken references" },
  { name: "OWASP ZAP Scan", frequency: "Weekly", description: "Full automated penetration testing against staging" },
  { name: "WCAG Accessibility Audit", frequency: "Monthly", description: "WCAG 2.2 automated audit (AA + AAA-aligned)" },
];

export default function ContinuousScanning() {
  return (
    <section className="py-24 px-6 border-t border-border/30">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            Always Watching
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            GateTest <span className="gradient-text">never sleeps</span>.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Even when no build is active, background scanners continuously monitor
            your dependencies, security posture, performance, and uptime.
            Threats don&apos;t wait for your next deploy. Neither does GateTest.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {scanners.map((scanner) => (
            <div
              key={scanner.name}
              className="flex items-start gap-4 rounded-xl p-4 border border-border bg-surface hover:border-accent/20 transition-colors"
            >
              <div className="shrink-0 mt-0.5">
                <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-sm">{scanner.name}</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] font-[var(--font-mono)] bg-accent/10 text-accent-light border border-accent/20">
                    {scanner.frequency}
                  </span>
                </div>
                <p className="text-xs text-muted leading-relaxed">{scanner.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
