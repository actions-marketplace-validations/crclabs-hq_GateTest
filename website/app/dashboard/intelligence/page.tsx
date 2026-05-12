"use client";

/**
 * Phase 5.1.4 — Intelligence dashboard.
 *
 * Customer-facing surface that turns the cross-repo intelligence brain
 * into a sales asset: "you're in the 87th percentile of similar Next 16 +
 * Stripe codebases. Here's what cohort leaders did differently."
 *
 * Data source: GET /api/dashboard/intelligence?repoUrl=...
 *
 * Privacy contract (mirrors the storage layer): NO repo URLs from the
 * cohort are shown — only framework versions + counts. The customer's
 * own repo URL is shown back to them but never persisted in cleartext.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

interface IntelligenceData {
  ok: boolean;
  repoUrlHash?: string;
  myLatestFingerprint?: {
    createdAt: string;
    tier: string;
    frameworkVersions: Record<string, string>;
    languageMix: Record<string, number>;
    totalFindings: number;
    totalFixed: number;
    fingerprintSignature: string;
  } | null;
  cohortStats?: {
    sampleSize: number;
    medianFindings: number;
    p90Findings: number;
    fixSuccessRate: number;
    daysBack: number;
  } | null;
  similarPriorScans?: Array<{
    createdAt: string;
    tier: string;
    frameworkVersions: Record<string, string>;
    totalFindings: number;
    totalFixed: number;
  }>;
  similaritySummary?: {
    sampleSize: number;
    moduleFireRate: Array<{ name: string; rate: number; count: number }>;
    moduleFixSuccessRate: Record<string, { rate: number; attempted: number; succeeded: number }>;
    medianTotalFindings: number;
    p90TotalFindings: number;
    overallFixRate: number;
  } | null;
  positioning?: {
    findingsPercentile: number;
    relativePosition: "leader" | "above_average" | "median" | "below_average" | "lagging";
    fixSuccessVsCohort: number;
  } | null;
  error?: string;
}

const POSITION_LABELS: Record<NonNullable<IntelligenceData["positioning"]>["relativePosition"], { label: string; tone: string }> = {
  leader: { label: "Leader", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  above_average: { label: "Above average", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  median: { label: "Around median", tone: "bg-amber-50 text-amber-700 border-amber-200" },
  below_average: { label: "Below average", tone: "bg-orange-50 text-orange-700 border-orange-200" },
  lagging: { label: "Lagging", tone: "bg-red-50 text-red-700 border-red-200" },
};

export default function IntelligenceDashboard() {
  const [repoUrl, setRepoUrl] = useState("");
  const [data, setData] = useState<IntelligenceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const r = sp.get("repoUrl") || "";
    if (r) {
      setRepoUrl(r);
      void load(r);
    }
  }, []);

  async function load(url: string) {
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await fetch(`/api/dashboard/intelligence?repoUrl=${encodeURIComponent(url)}`);
      const json = (await res.json()) as IntelligenceData;
      if (!json.ok) {
        setError(json.error || `Lookup failed (${res.status})`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (repoUrl.trim()) void load(repoUrl.trim());
  }

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold text-white"
              style={{ background: "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)" }}
            >
              ✦
            </span>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Intelligence</h1>
            <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
              Brain
            </span>
          </div>
          <p className="text-sm text-muted">
            Cross-repo comparison of this codebase against the cohort of similar stacks scanned by GateTest.
            Privacy: no repo URLs from the cohort are shown — only framework versions, language mix,
            and per-module statistics.
          </p>
        </div>

        <form onSubmit={onSubmit} className="mb-6 flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-label="Repository URL"
            className="flex-1 px-4 py-2 rounded-lg border border-border bg-white text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          />
          <button
            type="submit"
            disabled={loading || !repoUrl.trim()}
            className="btn-primary px-5 py-2 text-sm disabled:opacity-50"
            style={{ background: "#0f766e" }}
          >
            {loading ? "Looking up…" : "Compare"}
          </button>
        </form>

        {error && (
          <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 mb-6">
            {error}
          </div>
        )}

        {!data && !loading && !error && (
          <div className="p-8 rounded-2xl border border-border bg-white text-center text-sm text-muted">
            Enter a repo URL above to see how it compares to similar codebases scanned by GateTest.
          </div>
        )}

        {data && data.myLatestFingerprint === null && (
          <div className="p-8 rounded-2xl border border-amber-200 bg-amber-50 text-center">
            <p className="font-bold text-amber-800 mb-1">No prior scans found for this repo.</p>
            <p className="text-sm text-amber-700">
              Run a Full or Nuclear scan first — then come back here to see how it compares to similar stacks.
            </p>
            <Link href="/#pricing" className="mt-4 inline-block btn-primary px-5 py-2 text-sm" style={{ background: "#0f766e" }}>
              Run a scan →
            </Link>
          </div>
        )}

        {data && data.myLatestFingerprint && (
          <div className="space-y-6">
            {/* Position card — the headline */}
            {data.positioning && (
              <div
                className="rounded-2xl border border-border bg-white overflow-hidden"
                style={{ background: "linear-gradient(135deg, rgba(15,118,110,0.04) 0%, rgba(255,255,255,0) 100%)" }}
              >
                <div className="px-6 py-5 flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">Your position</p>
                    <h2 className="text-2xl font-bold text-foreground">
                      {POSITION_LABELS[data.positioning.relativePosition].label}
                      <span className="text-base font-normal text-muted ml-2">
                        {data.positioning.findingsPercentile}th percentile
                      </span>
                    </h2>
                  </div>
                  <div className={`px-3 py-1.5 rounded-full text-xs font-bold border ${POSITION_LABELS[data.positioning.relativePosition].tone}`}>
                    {data.positioning.relativePosition.toUpperCase().replace("_", " ")}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 border-t border-border">
                  <Stat label="Your findings" value={String(data.myLatestFingerprint.totalFindings)} />
                  <Stat label="Cohort median" value={String(data.cohortStats?.medianFindings ?? "—")} />
                  <Stat
                    label="Fix success vs cohort"
                    value={
                      data.positioning.fixSuccessVsCohort >= 0
                        ? `+${(data.positioning.fixSuccessVsCohort * 100).toFixed(0)}%`
                        : `${(data.positioning.fixSuccessVsCohort * 100).toFixed(0)}%`
                    }
                    tone={data.positioning.fixSuccessVsCohort >= 0 ? "positive" : "negative"}
                  />
                </div>
              </div>
            )}

            {/* Cohort + your stack */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card title="Your stack">
                <KvList
                  rows={Object.entries(data.myLatestFingerprint.frameworkVersions).map(([k, v]) => [k, String(v)])}
                  emptyText="No frameworks detected — scan ran on a non-JS/Python codebase or package manifest was missing."
                />
                <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted mb-2">Language mix</h3>
                <div className="space-y-1">
                  {Object.entries(data.myLatestFingerprint.languageMix)
                    .sort((a, b) => Number(b[1]) - Number(a[1]))
                    .slice(0, 6)
                    .map(([lang, share]) => (
                      <LanguageBar key={lang} lang={lang} share={Number(share)} />
                    ))}
                </div>
              </Card>

              <Card title={`Cohort (${data.cohortStats?.sampleSize ?? 0} similar codebases)`}>
                {data.cohortStats && data.cohortStats.sampleSize > 0 ? (
                  <KvList
                    rows={[
                      ["Sample size", `${data.cohortStats.sampleSize} repos`],
                      ["Lookback window", `${data.cohortStats.daysBack} days`],
                      ["Median findings", String(data.cohortStats.medianFindings)],
                      ["p90 findings", String(data.cohortStats.p90Findings)],
                      ["Cohort fix success rate", `${(data.cohortStats.fixSuccessRate * 100).toFixed(0)}%`],
                    ]}
                  />
                ) : (
                  <p className="text-sm text-muted">
                    Not enough scans of similar stacks yet. The cohort needs at least 3 scans to produce stats.
                  </p>
                )}
              </Card>
            </div>

            {/* Module fire-rate across cohort */}
            {data.similaritySummary && data.similaritySummary.moduleFireRate.length > 0 && (
              <Card title="What modules fire on similar codebases">
                <p className="text-xs text-muted mb-3">
                  Across {data.similaritySummary.sampleSize} similar codebases, these modules found at least one issue.
                  Use this to pre-empt issues your scan didn&apos;t hit yet.
                </p>
                <div className="space-y-1.5">
                  {data.similaritySummary.moduleFireRate.slice(0, 10).map((m) => (
                    <ModuleBar key={m.name} name={m.name} rate={m.rate} count={m.count} />
                  ))}
                </div>
              </Card>
            )}

            {/* Fix success per module */}
            {data.similaritySummary && Object.keys(data.similaritySummary.moduleFixSuccessRate).length > 0 && (
              <Card title="Cohort fix success rate by module">
                <p className="text-xs text-muted mb-3">
                  How often each module&apos;s findings were successfully auto-fixed by GateTest across the cohort.
                  Modules with fewer than 5 attempts are omitted (low signal).
                </p>
                <div className="space-y-1.5">
                  {Object.entries(data.similaritySummary.moduleFixSuccessRate)
                    .sort((a, b) => b[1].rate - a[1].rate)
                    .map(([name, o]) => (
                      <ModuleBar key={name} name={name} rate={o.rate} count={o.attempted} suffix="success" />
                    ))}
                </div>
              </Card>
            )}

            {/* Recent similar scans */}
            {data.similarPriorScans && data.similarPriorScans.length > 0 && (
              <Card title={`Recent similar scans (${data.similarPriorScans.length})`}>
                <p className="text-xs text-muted mb-3">
                  Deidentified — only frameworks + counts are shown. Repo URLs are never persisted in cleartext.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th className="text-left py-2 font-semibold">Date</th>
                        <th className="text-left py-2 font-semibold">Tier</th>
                        <th className="text-left py-2 font-semibold">Stack</th>
                        <th className="text-right py-2 font-semibold">Findings</th>
                        <th className="text-right py-2 font-semibold">Fixed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.similarPriorScans.map((s, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="py-2 text-muted">
                            {new Date(s.createdAt).toLocaleDateString()}
                          </td>
                          <td className="py-2">
                            <span className="inline-block px-1.5 py-0.5 rounded bg-background-alt text-foreground text-[11px] font-mono">
                              {s.tier}
                            </span>
                          </td>
                          <td className="py-2 text-foreground font-mono text-[11px]">
                            {Object.entries(s.frameworkVersions).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(" · ")}
                          </td>
                          <td className="py-2 text-right font-mono">{s.totalFindings}</td>
                          <td className="py-2 text-right font-mono">{s.totalFixed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            <p className="text-center text-xs text-muted pt-4">
              Powered by the GateTest cross-repo intelligence brain · gatetest.ai
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  const colorClass =
    tone === "positive" ? "text-emerald-700" : tone === "negative" ? "text-amber-700" : "text-foreground";
  return (
    <div className="px-6 py-4 border-r border-border last:border-r-0 text-center">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorClass} tabular-nums`}>{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-background-alt">
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function KvList({ rows, emptyText }: { rows: Array<[string, string]>; emptyText?: string }) {
  if (rows.length === 0 && emptyText) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <dl className="text-sm space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between border-b border-border/30 py-1 last:border-b-0">
          <dt className="text-muted">{k}</dt>
          <dd className="font-mono text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function LanguageBar({ lang, share }: { lang: string; share: number }) {
  const pct = Math.round(share * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono w-12 text-foreground">{lang}</span>
      <div className="flex-1 h-1.5 rounded-full bg-background-alt overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "#0f766e" }} />
      </div>
      <span className="text-muted tabular-nums w-10 text-right">{pct}%</span>
    </div>
  );
}

function ModuleBar({ name, rate, count, suffix }: { name: string; rate: number; count: number; suffix?: string }) {
  const pct = Math.round(rate * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-medium text-foreground w-32 truncate">{name}</span>
      <div className="flex-1 h-2 rounded-full bg-background-alt overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg, #0f766e 0%, #14b8a6 100%)" }}
        />
      </div>
      <span className="text-muted tabular-nums w-20 text-right">
        {pct}% {suffix && `(${count} ${suffix})`}
        {!suffix && `(n=${count})`}
      </span>
    </div>
  );
}
