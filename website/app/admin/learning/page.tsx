"use client";

/**
 * Phase 5.2.4 — /admin/learning operator dashboard.
 *
 * Surfaces the closed-feedback-loop's state so an operator can:
 *   - see which modules are getting noisy (low confidence score)
 *   - see which modules are stable (high confidence score)
 *   - see the dissent kind breakdown (where signals come from)
 *   - manually trigger a confidence refresh after dissent flows in
 *   - spot drift (a module's score dropping) before it hurts customers
 *
 * Auth: same admin-cookie pattern. Page itself just renders; auth
 * happens in the API routes.
 */

import { useCallback, useEffect, useState } from "react";

interface TrackedModule {
  module: string;
  patternHash: string | null;
  score: number;
  action: "trust" | "downgrade" | "double-down" | "suppress";
  dissentCount: number;
  distinctRepos: number;
  updatedAt: string;
}

interface KindBreakdown { kind: string; n: number; }
interface DissentRow {
  id: number;
  createdAt: string;
  module: string;
  patternHash: string | null;
  kind: string;
  fixPrNumber: number | null;
}

interface LearningData {
  ok: boolean;
  trackedModules?: TrackedModule[];
  kindsBreakdown?: KindBreakdown[];
  recentDissent?: DissentRow[];
  meta?: { windowDays: number };
  error?: string;
}

interface TrendBucket {
  date: string;
  totalDissent: number;
  byModule: Record<string, number>;
  byKind: Record<string, number>;
  distinctRepos: number;
  fpRate: number | null;
}

interface TrendData {
  ok: boolean;
  meta?: { daysBack: number; bucketDays: number; totalDissentRows: number };
  buckets?: TrendBucket[];
  summary?: {
    firstBucketRate: number | null;
    lastBucketRate: number | null;
    deltaPercent: number;
    direction: "no-data" | "insufficient-data" | "improving" | "regressing" | "flat";
  };
  error?: string;
}

interface RefreshStatus {
  ok: boolean;
  lastUpdated: string | null;
  tracked: number;
  minScore: number | null;
  maxScore: number | null;
  lowestScoreModule: string | null;
  error?: string;
}

const ACTION_TONE: Record<TrackedModule["action"], string> = {
  trust: "bg-emerald-50 text-emerald-700 border-emerald-200",
  downgrade: "bg-amber-50 text-amber-700 border-amber-200",
  "double-down": "bg-orange-50 text-orange-700 border-orange-200",
  suppress: "bg-red-50 text-red-700 border-red-200",
};

const KIND_LABEL: Record<string, string> = {
  rolled_back: "Rolled back",
  pr_closed_unmerged: "PR closed unmerged",
  false_positive: "False positive",
  fix_rejected: "Fix rejected",
  comment_downvote: "Comment downvote",
};

export default function LearningDashboard() {
  const [data, setData] = useState<LearningData | null>(null);
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [trend, setTrend] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [refreshMessage, setRefreshMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [learningRes, statusRes, trendRes] = await Promise.all([
        fetch("/api/admin/learning").then((r) => r.json() as Promise<LearningData>),
        fetch("/api/admin/learning/refresh").then((r) => r.json() as Promise<RefreshStatus>),
        fetch("/api/admin/learning/trend").then((r) => r.json() as Promise<TrendData>),
      ]);
      if (!learningRes.ok) {
        setError(learningRes.error || "Failed to load learning data");
      } else {
        setData(learningRes);
      }
      if (statusRes.ok) setStatus(statusRes);
      if (trendRes.ok) setTrend(trendRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function refresh() {
    setRefreshing(true);
    setRefreshMessage("");
    try {
      const res = await fetch("/api/admin/learning/refresh", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; updated?: number; scanned?: number; message?: string; error?: string };
      if (json.ok) {
        setRefreshMessage(json.message || `Refreshed ${json.updated} rows from ${json.scanned} aggregates.`);
        await load();
      } else {
        setRefreshMessage(json.error || "refresh failed");
      }
    } catch (e) {
      setRefreshMessage(e instanceof Error ? e.message : "request failed");
    } finally {
      setRefreshing(false);
    }
  }

  const totalDissent = (data?.kindsBreakdown || []).reduce((s, k) => s + (k.n || 0), 0);

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold text-white"
                style={{ background: "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)" }}
                aria-hidden
              >
                ✦
              </span>
              <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Learning</h1>
              <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
                5.2 — Closed feedback loop
              </span>
            </div>
            <p className="text-sm text-muted">
              Per-module confidence scores driven by customer dissent. Modules in red are being downgraded or suppressed.
              Refresh weekly via cron or manually from this page after dissent flows in.
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="btn-primary px-5 py-2 text-sm disabled:opacity-50"
            style={{ background: "#0f766e" }}
          >
            {refreshing ? "Refreshing…" : "Refresh confidence"}
          </button>
        </div>

        {refreshMessage && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 mb-4">
            {refreshMessage}
          </div>
        )}
        {error && (
          <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {/* Headline stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Stat label="Modules tracked" value={status?.tracked ?? 0} />
          <Stat
            label="Lowest score"
            value={status?.minScore != null ? status.minScore.toFixed(2) : "—"}
            tone={status?.minScore != null && status.minScore < 0.65 ? "negative" : "neutral"}
          />
          <Stat label="Highest score" value={status?.maxScore != null ? status.maxScore.toFixed(2) : "—"} tone="positive" />
          <Stat
            label="Dissent (30d)"
            value={totalDissent}
            tone={totalDissent > 50 ? "negative" : "neutral"}
          />
        </div>

        {loading && !data && (
          <div className="p-8 text-center text-sm text-muted">Loading learning data…</div>
        )}

        {data && (
          <div className="space-y-6">
            {/* Phase 6.2.5 — FP-rate trend chart. Proves the closed
                feedback loop is working: dissent volume + computed
                FP rate over time, with a one-line headline summary. */}
            {trend && trend.ok && trend.buckets && trend.buckets.length > 0 && (
              <Card title={`FP-rate trend (${trend.meta?.daysBack || 90}d, ${trend.meta?.bucketDays || 7}d buckets)`}>
                <TrendSummary summary={trend.summary} totalDissent={trend.meta?.totalDissentRows || 0} />
                <TrendChart buckets={trend.buckets} />
                <p className="mt-3 text-[11px] text-muted">
                  Each bar = one bucket. Bar height = total dissent in that bucket.
                  Dotted line = computed FP-rate (right axis). Lower = better. The
                  scoring math intentionally floors at 20% for any bucket with dissent
                  (matches the conservative 5× multiplier in module-confidence.js) —
                  the SHAPE of the trend is the signal, not the absolute number.
                </p>
              </Card>
            )}

            {/* Kinds breakdown */}
            {data.kindsBreakdown && data.kindsBreakdown.length > 0 && (
              <Card title={`Dissent by kind (${data.meta?.windowDays || 30}d window)`}>
                <div className="space-y-1.5">
                  {data.kindsBreakdown.map((k) => (
                    <KindBar key={k.kind} kind={k.kind} count={k.n} total={totalDissent} />
                  ))}
                </div>
              </Card>
            )}

            {/* Tracked modules */}
            <Card title={`Tracked modules (${data.trackedModules?.length || 0})`}>
              {data.trackedModules && data.trackedModules.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th className="text-left py-2 font-semibold">Module</th>
                        <th className="text-left py-2 font-semibold">Pattern</th>
                        <th className="text-right py-2 font-semibold">Score</th>
                        <th className="text-left py-2 font-semibold">Action</th>
                        <th className="text-right py-2 font-semibold">Dissent</th>
                        <th className="text-right py-2 font-semibold">Repos</th>
                        <th className="text-right py-2 font-semibold">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.trackedModules.map((m, i) => (
                        <tr key={`${m.module}-${m.patternHash ?? "all"}-${i}`} className="border-b border-border/40">
                          <td className="py-2 font-medium text-foreground">{m.module}</td>
                          <td className="py-2 font-mono text-muted">{m.patternHash || "(module-level)"}</td>
                          <td className="py-2 text-right font-mono tabular-nums">{m.score.toFixed(3)}</td>
                          <td className="py-2">
                            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${ACTION_TONE[m.action]}`}>
                              {m.action}
                            </span>
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums">{m.dissentCount}</td>
                          <td className="py-2 text-right font-mono tabular-nums">{m.distinctRepos}</td>
                          <td className="py-2 text-right text-muted">{relativeTime(m.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No modules tracked yet. Once dissent rows accumulate, run &quot;Refresh confidence&quot; to populate.
                </p>
              )}
            </Card>

            {/* Recent dissent */}
            <Card title={`Recent dissent events (${data.recentDissent?.length || 0})`}>
              {data.recentDissent && data.recentDissent.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th className="text-left py-2 font-semibold">When</th>
                        <th className="text-left py-2 font-semibold">Module</th>
                        <th className="text-left py-2 font-semibold">Kind</th>
                        <th className="text-left py-2 font-semibold">Pattern</th>
                        <th className="text-right py-2 font-semibold">PR #</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentDissent.map((r) => (
                        <tr key={r.id} className="border-b border-border/40">
                          <td className="py-2 text-muted">{relativeTime(r.createdAt)}</td>
                          <td className="py-2 font-medium text-foreground">{r.module}</td>
                          <td className="py-2">
                            <span className="inline-block px-1.5 py-0.5 rounded bg-background-alt text-foreground text-[10px] font-mono">
                              {KIND_LABEL[r.kind] || r.kind}
                            </span>
                          </td>
                          <td className="py-2 font-mono text-muted">{r.patternHash || "—"}</td>
                          <td className="py-2 text-right font-mono">{r.fixPrNumber ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted">No dissent recorded in the window.</p>
              )}
            </Card>
          </div>
        )}

        <p className="text-center text-xs text-muted pt-6">
          Phase 5.2 closed feedback loop · cron `0 6 * * 1` · gatetest.ai
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "positive" | "negative" | "neutral" }) {
  const colorClass =
    tone === "positive" ? "text-emerald-700"
      : tone === "negative" ? "text-amber-700"
      : "text-foreground";
  return (
    <div className="rounded-2xl border border-border bg-white px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${colorClass}`}>{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-background-alt">
        <h2 className="text-sm font-bold text-foreground">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function TrendSummary({
  summary,
  totalDissent,
}: {
  summary: TrendData["summary"];
  totalDissent: number;
}) {
  if (!summary || summary.direction === "no-data") {
    return (
      <p className="text-sm text-muted mb-3">
        No dissent recorded yet — ship a few customer scans, the trend will populate.
      </p>
    );
  }
  if (summary.direction === "insufficient-data") {
    return (
      <p className="text-sm text-muted mb-3">
        {totalDissent} dissent event{totalDissent === 1 ? "" : "s"} recorded so far —
        need at least two non-empty buckets before a trend can be drawn.
      </p>
    );
  }
  const tone =
    summary.direction === "improving"
      ? "text-emerald-700"
      : summary.direction === "regressing"
        ? "text-amber-700"
        : "text-foreground";
  const arrow =
    summary.direction === "improving" ? "↓" : summary.direction === "regressing" ? "↑" : "→";
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <span className={`text-2xl font-bold tabular-nums ${tone}`}>
        {arrow} {Math.abs(summary.deltaPercent)}%
      </span>
      <span className="text-sm text-muted">
        FP rate {summary.direction === "regressing" ? "regressed" : summary.direction === "improving" ? "improved" : "stayed flat"} vs the start of the window
        {" "}
        ({(summary.firstBucketRate ?? 0).toFixed(2)} → {(summary.lastBucketRate ?? 0).toFixed(2)}).
        {totalDissent > 0 && ` Based on ${totalDissent} dissent event${totalDissent === 1 ? "" : "s"}.`}
      </span>
    </div>
  );
}

function TrendChart({ buckets }: { buckets: TrendBucket[] }) {
  // Pure-CSS bar+line chart — no chart-library dep. Bars = dissent
  // count (left axis); a tinted overlay band = computed FP rate
  // (right axis, 0-100%).
  const maxDissent = Math.max(1, ...buckets.map((b) => b.totalDissent));
  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-1 min-h-[120px] pt-2">
        {buckets.map((b) => {
          const heightPct = b.totalDissent === 0 ? 0 : Math.max(2, (b.totalDissent / maxDissent) * 100);
          const ratePct = b.fpRate == null ? 0 : Math.round(b.fpRate * 100);
          return (
            <div
              key={b.date}
              className="flex flex-col items-center min-w-[24px] flex-1 group"
              title={`${b.date} · dissent=${b.totalDissent} · FP=${b.fpRate ?? "n/a"} · repos=${b.distinctRepos}`}
            >
              <div className="relative w-full flex items-end" style={{ height: 110 }}>
                <div
                  className="w-full rounded-t transition-all"
                  style={{
                    height: `${heightPct}%`,
                    background:
                      b.fpRate == null
                        ? "var(--color-surface-light, #f1f5f9)"
                        : "linear-gradient(180deg, #14b8a6 0%, #0f766e 100%)",
                    opacity: b.fpRate == null ? 0.3 : 0.85,
                  }}
                />
                {b.fpRate != null && (
                  <span
                    className="absolute -top-1 left-1/2 -translate-x-1/2 text-[9px] font-mono font-bold text-foreground bg-white/80 backdrop-blur rounded px-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    {ratePct}%
                  </span>
                )}
              </div>
              <span className="text-[9px] text-muted mt-1 font-mono truncate w-full text-center">
                {b.date.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KindBar({ kind, count, total }: { kind: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-medium text-foreground w-44 truncate">{KIND_LABEL[kind] || kind}</span>
      <div className="flex-1 h-2 rounded-full bg-background-alt overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg, #0f766e 0%, #14b8a6 100%)" }} />
      </div>
      <span className="text-muted tabular-nums w-20 text-right">{count} ({pct}%)</span>
    </div>
  );
}

function relativeTime(ts?: string | null): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
