"use client";

/**
 * <UrlScanFlow>
 *
 * The customer-facing flow for paste-URL → scan → results, shared by the
 * /web (any public site) and /wp (WordPress-specific) landing pages. Both
 * pages render this component with different suite props.
 *
 * Design rules:
 *   - Bible: "the scan experience must be CINEMATIC." So we show a live
 *     module-by-module ticker during the ~10-30s the scan takes, animate
 *     the health-score reveal, and stagger the findings cards in.
 *   - Health score (0-100) is the centerpiece — big number, letter grade,
 *     colour-coded by severity. Customer wants a verdict, not a list.
 *   - Findings are CLUSTERS (1 missing CSP header = 1 row), not raw
 *     findings. Instance count surfaces next to the title.
 *   - Severity badges: error red, warning amber, info gray. High-signal
 *     clusters carry a 🔥 flag.
 *   - Runtime status: hide entirely when "unavailable". Show progress
 *     when "queued" (poll until "completed"), then render runtime findings
 *     inline with the static ones.
 *   - Paywall CTA appears below the findings when preview === true.
 *
 * Accessibility:
 *   - All interactive elements keyboard-focusable + visible focus rings.
 *   - aria-live region announces scan state changes.
 *   - Findings expand/collapse via <details>/<summary> (no JS state needed).
 *   - Color is never the only signal — severity also carries a label.
 *
 * Mobile: stacks cleanly at 320px. No horizontal scroll. Big touch targets.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Severity = "error" | "warning" | "info";

interface Finding {
  severity: Severity;
  title: string;
  body: string;
  module: string;
  ruleKey: string;
  instanceCount?: number;
  highSignal?: boolean;
}

interface HealthScore {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
}

interface RuntimeBlock {
  status: "queued" | "completed" | "failed" | "unavailable";
  jobId?: string | null;
  reason?: string | null;
  pollUrl?: string | null;
  payload?: {
    status?: string;
    durationMs?: number;
    findings?: Array<{ name: string; severity: Severity; passed: boolean; message: string }>;
    error?: string;
  };
}

interface ScanResult {
  scanId?: string;
  targetUrl: string;
  scannedAt: string;
  duration: number;
  healthScore: HealthScore;
  totalFindings: number;
  totalClusters: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  preview: boolean;
  findings: Finding[];
  runtime?: RuntimeBlock | null;
  paywall: {
    remainingCount: number;
    fullReportPriceUsd: number;
    fullReportCadence: string;
    ctaUrl: string;
  } | null;
}

interface UrlScanFlowProps {
  suite: "web" | "wp";
  endpoint: string;
  placeholderUrl?: string;
  brandLabel?: string;
}

const MODULE_TICKER: Record<"web" | "wp", string[]> = {
  web: [
    "Checking HTTPS / TLS certificate",
    "Reading security headers (CSP, HSTS, X-Frame-Options)",
    "Inspecting cookies for Secure / HttpOnly flags",
    "Crawling links for broken pages",
    "Measuring page performance",
    "Auditing accessibility",
    "Sweeping for SEO issues",
    "Queueing live-browser runtime check",
  ],
  wp: [
    "Probing for exposed sensitive files",
    "Looking up WordPress version disclosure",
    "Testing XML-RPC endpoint",
    "Checking plugin CVE database",
    "Scanning for malware patterns",
    "Testing user enumeration",
    "Auditing admin endpoint protection",
    "Checking PHP version end-of-life",
    "Reading security headers (CSP, HSTS, X-Frame-Options)",
    "Inspecting cookies for Secure / HttpOnly flags",
    "Auditing accessibility",
    "Sweeping for SEO issues",
    "Queueing live-browser runtime check",
  ],
};

const GRADE_COLORS: Record<"A" | "B" | "C" | "D" | "F", { bar: string; text: string; bg: string; ring: string }> = {
  A: { bar: "bg-emerald-500", text: "text-emerald-600", bg: "bg-emerald-50", ring: "ring-emerald-300" },
  B: { bar: "bg-lime-500", text: "text-lime-700", bg: "bg-lime-50", ring: "ring-lime-300" },
  C: { bar: "bg-amber-500", text: "text-amber-700", bg: "bg-amber-50", ring: "ring-amber-300" },
  D: { bar: "bg-orange-500", text: "text-orange-700", bg: "bg-orange-50", ring: "ring-orange-300" },
  F: { bar: "bg-rose-500", text: "text-rose-700", bg: "bg-rose-50", ring: "ring-rose-300" },
};

const SEVERITY_STYLES: Record<Severity, { badge: string; text: string; dot: string; label: string }> = {
  error: {
    badge: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200",
    text: "text-rose-700",
    dot: "bg-rose-500",
    label: "Error",
  },
  warning: {
    badge: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
    text: "text-amber-700",
    dot: "bg-amber-500",
    label: "Warning",
  },
  info: {
    badge: "bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-200",
    text: "text-slate-600",
    dot: "bg-slate-400",
    label: "Info",
  },
};

function HealthScoreCard({ score, grade, summary }: HealthScore) {
  const colors = GRADE_COLORS[grade];
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    let current = 0;
    const target = score;
    const stepMs = 18;
    const steps = 40;
    const inc = target / steps;
    const id = setInterval(() => {
      current += inc;
      if (current >= target) {
        current = target;
        clearInterval(id);
      }
      setDisplayScore(Math.round(current));
    }, stepMs);
    return () => clearInterval(id);
  }, [score]);

  return (
    <div className={`rounded-3xl border border-border ${colors.bg} p-8 sm:p-10 ring-1 ${colors.ring}`}>
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-8">
        <div className="flex flex-col items-center sm:items-start shrink-0">
          <p className="text-sm font-medium uppercase tracking-wider text-muted mb-1">Health Score</p>
          <div className="flex items-baseline gap-2">
            <span className="text-7xl sm:text-8xl font-bold tabular-nums tracking-tight text-foreground">
              {displayScore}
            </span>
            <span className="text-2xl font-semibold text-muted">/ 100</span>
          </div>
        </div>

        <div className="flex-1 w-full">
          <div className="flex items-center gap-3 mb-3">
            <span
              className={`inline-flex items-center justify-center w-12 h-12 rounded-full text-2xl font-bold ${colors.bar} text-white shadow-md`}
              aria-label={`Grade ${grade}`}
            >
              {grade}
            </span>
            <div>
              <p className="text-lg font-semibold text-foreground">Grade {grade}</p>
              <p className="text-sm text-muted">
                {grade === "A" && "Excellent — your site is well-hardened"}
                {grade === "B" && "Good — a few hardening opportunities"}
                {grade === "C" && "Fair — meaningful issues need attention"}
                {grade === "D" && "Poor — significant security & quality gaps"}
                {grade === "F" && "Critical — multiple urgent issues found"}
              </p>
            </div>
          </div>

          {/* Score bar */}
          <div className="w-full h-3 rounded-full bg-white/60 overflow-hidden shadow-inner">
            <div
              className={`h-full ${colors.bar} transition-all duration-1000 ease-out`}
              style={{ width: `${score}%` }}
              aria-hidden
            />
          </div>

          <p className="text-sm text-muted mt-3">{summary}</p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number | string; accent: "rose" | "amber" | "slate" | "teal" }) {
  const accentMap = {
    rose: "text-rose-600",
    amber: "text-amber-600",
    slate: "text-slate-600",
    teal: "text-accent",
  };
  return (
    <div className="rounded-2xl border border-border bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className={`text-3xl font-bold tabular-nums mt-1 ${accentMap[accent]}`}>{value}</p>
    </div>
  );
}

function FindingRow({ finding, index }: { finding: Finding; index: number }) {
  const sev = SEVERITY_STYLES[finding.severity];
  const showCount = finding.instanceCount && finding.instanceCount > 1;
  return (
    <details
      className="group rounded-2xl border border-border bg-white overflow-hidden transition-shadow hover:shadow-sm"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <summary className="list-none cursor-pointer p-5 flex items-start gap-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <span className={`shrink-0 mt-1 w-2.5 h-2.5 rounded-full ${sev.dot}`} aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className={`text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md ${sev.badge}`}>
              {sev.label}
            </span>
            {finding.highSignal && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200">
                🔥 High signal
              </span>
            )}
            {showCount && (
              <span className="text-xs font-medium text-muted">
                {finding.instanceCount} occurrence{finding.instanceCount! > 1 ? "s" : ""}
              </span>
            )}
            <span className="text-xs font-mono text-muted truncate">{finding.module}</span>
          </div>
          <h3 className="font-semibold text-foreground leading-snug">{finding.title}</h3>
        </div>
        <svg
          className="shrink-0 w-5 h-5 text-muted transition-transform group-open:rotate-180 mt-1"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </summary>
      <div className="px-5 pb-5 -mt-2">
        <div className="border-t border-border pt-4 text-sm text-muted whitespace-pre-line leading-relaxed">
          {finding.body || "No additional detail."}
        </div>
        <p className="mt-3 text-xs font-mono text-muted">Rule: <span className="text-foreground">{finding.ruleKey}</span></p>
      </div>
    </details>
  );
}

function PaywallCard({ paywall, targetUrl }: { paywall: NonNullable<ScanResult["paywall"]>; targetUrl: string }) {
  return (
    <div className="rounded-3xl bg-foreground text-background p-8 sm:p-10">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
        <div className="flex-1">
          <p className="text-sm font-medium uppercase tracking-wider text-background/60 mb-2">Free preview ends here</p>
          <h3 className="text-2xl sm:text-3xl font-bold leading-tight mb-2">
            {paywall.remainingCount} more issues hidden behind the full report
          </h3>
          <p className="text-background/80 leading-relaxed">
            See every finding, plain-English fix instructions, and the full health-score breakdown.
            One-shot purchase, no subscription, no signup. Pay only if you want the details.
          </p>
        </div>
        <Link
          href={`${paywall.ctaUrl}&url=${encodeURIComponent(targetUrl)}`}
          className="shrink-0 inline-flex items-center justify-center gap-2 px-7 py-4 rounded-xl bg-accent text-white font-semibold hover:bg-accent-hover transition-colors text-lg"
        >
          Unlock for ${paywall.fullReportPriceUsd}
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

function ProgressTicker({ suite, elapsedSec }: { suite: "web" | "wp"; elapsedSec: number }) {
  const items = MODULE_TICKER[suite];
  const activeIndex = Math.min(items.length - 1, Math.floor(elapsedSec / 1.6));
  return (
    <div className="rounded-3xl border border-border bg-white p-6 sm:p-8" role="status" aria-live="polite">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full bg-accent animate-pulse" aria-hidden />
          <p className="font-semibold text-foreground">Scanning your site...</p>
        </div>
        <p className="text-sm text-muted font-mono tabular-nums">{elapsedSec.toFixed(1)}s</p>
      </div>
      <ul className="space-y-2.5">
        {items.map((label, i) => {
          const done = i < activeIndex;
          const active = i === activeIndex;
          return (
            <li
              key={label}
              className={`flex items-center gap-3 text-sm transition-opacity ${
                i > activeIndex + 2 ? "opacity-30" : ""
              }`}
            >
              <span
                className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                  done ? "bg-emerald-500 text-white" : active ? "bg-accent/15 text-accent" : "bg-slate-100 text-slate-400"
                }`}
                aria-hidden
              >
                {done ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                ) : active ? (
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                ) : null}
              </span>
              <span className={done ? "text-foreground" : active ? "text-foreground font-medium" : "text-muted"}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RuntimePending({ pollUrl, onComplete }: { pollUrl: string; onComplete: (rt: RuntimeBlock["payload"]) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(pollUrl, { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        if (data?.runtime?.status === "completed" || data?.runtime?.status === "failed") {
          onCompleteRef.current(data.runtime.payload);
          clearInterval(poll);
          clearInterval(tick);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [pollUrl]);

  return (
    <div className="rounded-2xl border border-border bg-blue-50 p-5 ring-1 ring-blue-100">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-blue-500/15 flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" aria-hidden />
        </span>
        <div className="flex-1">
          <p className="font-semibold text-blue-900 leading-tight">Live browser check running…</p>
          <p className="text-sm text-blue-800/80 mt-1">
            We&apos;re loading your site in a real Chromium and watching for JavaScript errors,
            hydration mismatches, CSP violations and broken network requests. Usually 10-30 seconds. <span className="font-mono tabular-nums">{elapsed}s elapsed.</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export function UrlScanFlow({ suite, endpoint, placeholderUrl = "https://yoursite.com", brandLabel }: UrlScanFlowProps) {
  type Phase = "idle" | "scanning" | "results" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const tickerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (phase === "scanning") {
      const start = Date.now();
      tickerRef.current = setInterval(() => {
        setElapsedSec((Date.now() - start) / 1000);
      }, 100);
    } else {
      if (tickerRef.current) clearInterval(tickerRef.current);
      tickerRef.current = null;
      setElapsedSec(0);
    }
    return () => {
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [phase]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);
    setPhase("scanning");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Scan failed. Please try a different URL.");
        setPhase("error");
        return;
      }
      setResult(data as ScanResult);
      setPhase("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — please try again.");
      setPhase("error");
    }
  }

  function reset() {
    setResult(null);
    setError(null);
    setPhase("idle");
    setUrl("");
  }

  function applyRuntimePayload(payload: RuntimeBlock["payload"]) {
    if (!result || !payload || !Array.isArray(payload.findings)) return;
    const newFindings: Finding[] = payload.findings
      .filter((f) => f.passed === false && f.severity !== "info")
      .map((f) => ({
        severity: f.severity,
        title: f.message.slice(0, 100),
        body: f.message,
        module: "runtimeErrors",
        ruleKey: f.name,
        instanceCount: 1,
        highSignal: f.name.includes("csp-violation") || f.name.includes("page-error"),
      }));
    setResult({
      ...result,
      findings: [...result.findings, ...newFindings],
      runtime: { ...result.runtime!, status: "completed", payload },
    });
  }

  // Hide runtime block entirely when unavailable — don't leak infra gaps.
  const showRuntime = result?.runtime?.status === "queued" || result?.runtime?.status === "completed";

  return (
    <div className="w-full">
      {/* Form is always visible at the top so the customer can re-scan */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col sm:flex-row items-stretch justify-center gap-3 max-w-xl mx-auto"
      >
        <label className="sr-only" htmlFor="url-scan-input">
          Website URL to scan
        </label>
        <input
          id="url-scan-input"
          type="url"
          name="url"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholderUrl}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={phase === "scanning"}
          className="flex-1 px-5 py-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent text-lg disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={phase === "scanning" || !url.trim()}
          className="px-8 py-4 rounded-xl bg-accent text-white font-semibold text-lg hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase === "scanning" ? "Scanning…" : "Scan my site"}
        </button>
      </form>

      {phase === "idle" && (
        <p className="text-center text-sm text-muted mt-6">
          Free preview — top 3 issues plus your Health Score. No signup, no install.
        </p>
      )}

      {/* SCANNING STATE — cinematic progress ticker */}
      {phase === "scanning" && (
        <div className="mt-10 max-w-2xl mx-auto">
          <ProgressTicker suite={suite} elapsedSec={elapsedSec} />
        </div>
      )}

      {/* ERROR STATE — helpful, not scary */}
      {phase === "error" && (
        <div className="mt-10 max-w-2xl mx-auto">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 ring-1 ring-rose-100" role="alert">
            <h2 className="font-semibold text-rose-900 mb-1">We couldn&apos;t scan that URL</h2>
            <p className="text-sm text-rose-900/80">{error}</p>
            <button
              onClick={reset}
              className="mt-4 px-4 py-2 rounded-lg bg-rose-600 text-white font-medium hover:bg-rose-700 transition-colors"
            >
              Try a different URL
            </button>
          </div>
        </div>
      )}

      {/* RESULTS STATE */}
      {phase === "results" && result && (
        <div className="mt-12 max-w-4xl mx-auto space-y-8">
          {/* Scanned URL banner */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted">
              Scanned <span className="font-mono text-foreground">{result.targetUrl}</span> in{" "}
              <span className="font-mono tabular-nums text-foreground">{(result.duration / 1000).toFixed(1)}s</span>
              {brandLabel && <span className="ml-2 text-muted">• {brandLabel}</span>}
            </p>
            <button
              onClick={reset}
              className="text-accent hover:text-accent-hover font-medium transition-colors focus:outline-none focus-visible:underline"
            >
              Scan a different URL →
            </button>
          </div>

          {/* Health score hero */}
          <HealthScoreCard {...result.healthScore} />

          {/* Stat row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Errors" value={result.errorCount} accent="rose" />
            <StatCard label="Warnings" value={result.warningCount} accent="amber" />
            <StatCard label="Root causes" value={result.totalClusters} accent="teal" />
            <StatCard label="Raw findings" value={result.totalFindings} accent="slate" />
          </div>

          {/* Runtime status — ONLY when queued or completed; hidden when unavailable */}
          {showRuntime && result.runtime?.status === "queued" && result.runtime.pollUrl && (
            <RuntimePending pollUrl={result.runtime.pollUrl} onComplete={applyRuntimePayload} />
          )}

          {/* Findings list */}
          {result.findings.length > 0 ? (
            <div>
              <h2 className="text-xl font-bold mb-4">
                {result.preview ? "Top issues — free preview" : "Every issue found"}
              </h2>
              <p className="text-sm text-muted mb-5">
                Click any row for plain-language detail and fix guidance.
              </p>
              <div className="space-y-3">
                {result.findings.map((f, i) => (
                  <FindingRow key={`${f.ruleKey}-${i}`} finding={f} index={i} />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
              <p className="text-emerald-900 font-semibold">No issues in the modules we ran 🎉</p>
              <p className="text-sm text-emerald-900/80 mt-1">
                Consider running a deeper suite to check more dimensions.
              </p>
            </div>
          )}

          {/* Paywall CTA */}
          {result.paywall && result.paywall.remainingCount > 0 && (
            <PaywallCard paywall={result.paywall} targetUrl={result.targetUrl} />
          )}

          {/* Sub-footer */}
          <div className="text-center pt-4">
            <p className="text-xs text-muted">
              Powered by the{" "}
              <Link href="/" className="text-accent hover:underline font-medium">
                GateTest
              </Link>{" "}
              engine — 90+ static checks plus live browser runtime capture.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
