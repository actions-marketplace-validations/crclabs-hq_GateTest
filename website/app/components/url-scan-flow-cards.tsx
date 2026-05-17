"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  type Finding,
  type HealthScore,
  type Recommendation,
  type ScanResult,
  GRADE_COLORS,
  SEVERITY_STYLES,
} from "./url-scan-flow-types";

export function HealthScoreCard({ score, grade, summary }: HealthScore) {
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

export function StatCard({ label, value, accent }: { label: string; value: number | string; accent: "rose" | "amber" | "slate" | "teal" }) {
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

export function FindingRow({ finding, index }: { finding: Finding; index: number }) {
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

export function RecommendationCard({ rec }: { rec: Recommendation }) {
  const detected = rec.detected || {};
  const detectedBits: string[] = [];
  if (detected.cms) detectedBits.push(detected.cms);
  if (detected.framework) detectedBits.push(detected.framework);
  if (detected.cdn && detected.cdn !== detected.server) detectedBits.push(detected.cdn);
  if (detected.server) detectedBits.push(detected.server);
  if (detected.language) detectedBits.push(detected.language);
  return (
    <div className="mt-6 max-w-2xl mx-auto rounded-2xl border border-accent/20 bg-accent/5 p-5">
      <div className="flex items-start gap-3">
        <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-accent/15 text-accent text-sm font-bold">✦</span>
        <div className="flex-1">
          <div className="flex flex-wrap items-baseline gap-2 mb-2">
            <p className="font-semibold text-foreground">Detected</p>
            {detectedBits.length > 0 ? (
              <p className="text-sm text-muted">
                {detectedBits.map((d, i) => (
                  <span key={d}>
                    {i > 0 && <span className="mx-1.5 text-muted/60">·</span>}
                    <span className="text-foreground font-medium">{d}</span>
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-sm text-muted">No specific framework — generic web site</p>
            )}
          </div>
          <p className="text-sm text-foreground/90 leading-relaxed">
            <span className="font-semibold">Recommended:</span>{" "}
            {rec.recommendation.suiteDescription.toLowerCase()} at{" "}
            <span className="font-semibold capitalize">{rec.recommendation.tier.replace("_", " + ")}</span> tier
            {rec.recommendation.tier !== "quick" && (
              <span className="text-muted"> (${rec.recommendation.priceUsd})</span>
            )}
            .
          </p>
          {rec.recommendation.reasoning[0] && (
            <p className="text-sm text-muted leading-relaxed mt-1">
              {rec.recommendation.reasoning[0]}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function PaywallCard({ paywall, targetUrl }: { paywall: NonNullable<ScanResult["paywall"]>; targetUrl: string }) {
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
