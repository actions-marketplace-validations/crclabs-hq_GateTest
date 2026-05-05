"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import FindingsPanel from "@/app/components/FindingsPanel";
import SiblingProducts from "@/app/components/SiblingProducts";

interface ModuleSummary {
  name: string;
  status: "passed" | "failed" | "skipped" | "pending" | "running";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

interface ScanRecord {
  id: string;
  session_id: string;
  repo_url: string;
  tier: string;
  status: string;
  score: number | null;
  duration_ms: number | null;
  tier_price_usd: string | null;
  summary: string | null;
  created_at: string;
  completed_at: string | null;
  results: Record<string, unknown> | null;
}

interface CustomerInfo {
  login: string;
  email: string;
}

interface DashboardData {
  scans: ScanRecord[];
  customer: CustomerInfo | null;
  note?: string;
}

interface ScanHistoryRow {
  id: number;
  tier: string;
  total_issues: number;
  total_modules: number;
  duration_ms: number | null;
  scanned_at: string;
  module_summary: Array<{ name: string; status: string; issues: number }> | null;
}

/** Format a duration in ms as a human-readable string, e.g. "34s" or "1m 12s". */
function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Format a timestamp as a relative "X ago" string, falling back to locale date. */
function timeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return new Date(isoString).toLocaleDateString();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 5) return `${diffWk}w ago`;
  return new Date(isoString).toLocaleDateString();
}

export default function Dashboard() {
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [expandedScan, setExpandedScan] = useState<string | null>(null);
  const [scanHistory, setScanHistory] = useState<ScanHistoryRow[]>([]);
  const [historyRepo, setHistoryRepo] = useState<string>("");

  // Check auth status on mount
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.login) {
          setCustomer(d);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loadScans = useCallback(async () => {
    if (!customer) return;
    try {
      const res = await fetch("/api/dashboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: customer.email }),
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      // silent
    }
  }, [customer]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (customer) loadScans();
  }, [customer, loadScans]);

  // Load scan history when a specific repo is in the page URL params.
  // Activated by navigating to /dashboard?repo=<url> or ?repo_url=<url>.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const repo = params.get("repo") || params.get("repo_url") || "";
    if (!repo) return;
    setHistoryRepo(repo);
    fetch(`/api/scan/history?repo=${encodeURIComponent(repo)}&limit=20`)
      .then((r) => (r.ok ? r.json() : { history: [] }))
      .then((d: { history?: ScanHistoryRow[] }) =>
        setScanHistory(d.history || [])
      )
      .catch(() => setScanHistory([]));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setCustomer(null);
    setData(null);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Not logged in — show sign-in
  if (!customer) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <div className="max-w-sm w-full text-center">
          <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center mx-auto mb-6">
            <span className="text-white font-bold text-xl font-[var(--font-mono)]">G</span>
          </div>
          <h1 className="text-2xl font-bold mb-2">Sign in to GateTest</h1>
          <p className="text-muted text-sm mb-8">
            View your scan history, detailed results, and manage your repos.
          </p>
          <a
            href="/api/auth/github"
            className="btn-cta w-full py-3.5 text-sm block text-center rounded-xl font-semibold"
          >
            Sign in with GitHub
          </a>
          <div className="mt-6">
            <Link href="/" className="text-sm text-muted hover:text-foreground">
              &larr; Back to GateTest
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Logged in — dashboard
  const scans = data?.scans || [];

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-sm text-muted">
              Signed in as <span className="font-mono font-medium">{customer.login}</span>
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/#pricing" className="btn-primary px-5 py-2.5 text-sm">
              New Scan
            </Link>
            <button
              onClick={logout}
              className="text-sm text-muted hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Stats */}
        {scans.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
            <div className="card p-4 text-center">
              <p className="text-2xl font-bold">{scans.length}</p>
              <p className="text-xs text-muted">Total Scans</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-2xl font-bold">
                {scans.filter((s) => s.status === "completed").length}
              </p>
              <p className="text-xs text-muted">Completed</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-2xl font-bold">
                {scans[0]?.score != null ? scans[0].score : "—"}
              </p>
              <p className="text-xs text-muted">Latest Score</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-2xl font-bold">
                $
                {scans
                  .reduce(
                    (sum, s) => sum + Number(s.tier_price_usd || 0),
                    0
                  )
                  .toFixed(0)}
              </p>
              <p className="text-xs text-muted">Total Spent</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {scans.length === 0 && (
          <div className="space-y-6">
            <div className="card p-12 text-center">
              <p className="text-lg font-bold mb-2">No scans yet</p>
              <p className="text-muted text-sm mb-6">
                Run your first scan to see results here.
              </p>
              <Link
                href="/#pricing"
                className="btn-primary px-6 py-3 text-sm inline-block"
              >
                Scan Your First Repo
              </Link>
            </div>
            <SiblingProducts />
          </div>
        )}

        {/* Scan list */}
        {scans.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-lg font-bold">Your Scans</h2>
            {scans.map((scan) => {
              const isExpanded = expandedScan === scan.id;
              const modules = Array.isArray(
                (scan.results as Record<string, unknown>)?.modules
              )
                ? ((scan.results as Record<string, unknown>).modules as Array<Record<string, unknown>>)
                : [];

              return (
                <div key={scan.id} className="card overflow-hidden">
                  {/* Scan header — clickable */}
                  <button
                    onClick={() =>
                      setExpandedScan(isExpanded ? null : scan.id)
                    }
                    className="w-full p-5 text-left hover:bg-gray-50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-sm font-medium truncate max-w-[60%]">
                        {scan.repo_url.replace("https://github.com/", "")}
                      </span>
                      <span
                        className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                          scan.status === "completed"
                            ? "bg-green-50 text-success"
                            : scan.status === "failed"
                              ? "bg-red-50 text-danger"
                              : "bg-yellow-50 text-warning"
                        }`}
                      >
                        {scan.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted">
                      <span>{scan.tier} scan</span>
                      {scan.score != null && <span>Score: {scan.score}</span>}
                      {scan.duration_ms && (
                        <span>{(scan.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                      {scan.tier_price_usd && (
                        <span>${Number(scan.tier_price_usd).toFixed(0)}</span>
                      )}
                      <span className="ml-auto">
                        {scan.created_at
                          ? new Date(scan.created_at).toLocaleDateString()
                          : ""}
                      </span>
                      <span className="text-accent">
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </div>
                  </button>

                  {/* Expanded: module results */}
                  {isExpanded && (
                    <div className="border-t border-border px-5 py-4 bg-gray-50/50">
                      {scan.summary && (
                        <p className="text-sm text-muted mb-4">
                          {scan.summary}
                        </p>
                      )}

                      {modules.length > 0 ? (
                        <div className="space-y-4">
                          {/* Module summary grid */}
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {modules.map((mod) => {
                              const status = mod.status as string;
                              const issues = (mod.issues as number) || 0;
                              const name = mod.name as string;
                              return (
                                <div
                                  key={name}
                                  className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs ${
                                    status === "passed"
                                      ? "border-green-100 bg-white"
                                      : status === "failed"
                                        ? "border-red-200 bg-red-50/40"
                                        : "border-border bg-white"
                                  }`}
                                >
                                  <span
                                    className={`w-5 h-5 rounded-md flex items-center justify-center font-bold text-[10px] ${
                                      status === "passed"
                                        ? "bg-green-100 text-green-700"
                                        : status === "failed"
                                          ? "bg-red-100 text-red-700"
                                          : "bg-slate-100 text-slate-500"
                                    }`}
                                  >
                                    {status === "passed"
                                      ? "✓"
                                      : status === "failed"
                                        ? "!"
                                        : "–"}
                                  </span>
                                  <span className="font-medium text-foreground truncate flex-1">
                                    {name}
                                  </span>
                                  {issues > 0 && (
                                    <span className="text-red-600 font-semibold">
                                      {issues}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {/* Beautiful findings panel */}
                          <FindingsPanel
                            modules={modules as unknown as ModuleSummary[]}
                            repoUrl={scan.repo_url}
                          />
                        </div>
                      ) : (
                        <p className="text-sm text-muted">
                          Detailed module results not available for this scan.
                        </p>
                      )}

                      {/* Link to full results */}
                      <div className="mt-4 pt-3 border-t border-border">
                        <a
                          href={`/scan/status?session_id=${scan.session_id}&repo_url=${encodeURIComponent(scan.repo_url)}&tier=${scan.tier}`}
                          className="text-sm text-accent hover:underline"
                        >
                          View full scan results &rarr;
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Scan History section ──────────────────────────────────────────
            Shows when a repo URL is provided as a query param:
            /dashboard?repo=<url> or /dashboard?repo_url=<url>
            Lets customers track improvement over time:
            "last week: 54 errors, today: 12 errors."
        ─────────────────────────────────────────────────────────────────── */}
        {historyRepo && (
          <div className="mt-10">
            <h2 className="text-lg font-bold mb-4">
              Scan History
              <span className="ml-2 text-sm font-mono text-muted font-normal truncate">
                {historyRepo.replace(/^https?:\/\//, "")}
              </span>
            </h2>

            {scanHistory.length === 0 ? (
              <div className="card p-8 text-center">
                <p className="text-muted text-sm">
                  No scan history yet — run your first scan above.
                </p>
              </div>
            ) : (
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted">
                      <th className="text-left px-5 py-3 font-medium">Date</th>
                      <th className="text-left px-5 py-3 font-medium">Tier</th>
                      <th className="text-right px-5 py-3 font-medium">Issues</th>
                      <th className="text-right px-5 py-3 font-medium">Modules</th>
                      <th className="text-right px-5 py-3 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanHistory.map((row, idx) => {
                      // Trend arrow: compare this row against the next older row.
                      // Down arrow (green) = fewer issues = improving.
                      const olderRow = scanHistory[idx + 1];
                      let trendEl: React.ReactNode = null;
                      if (olderRow) {
                        if (row.total_issues < olderRow.total_issues) {
                          trendEl = (
                            <span
                              className="ml-1.5 text-success text-xs font-bold"
                              title="Improving"
                            >
                              &darr;
                            </span>
                          );
                        } else if (row.total_issues > olderRow.total_issues) {
                          trendEl = (
                            <span
                              className="ml-1.5 text-danger text-xs font-bold"
                              title="Regressing"
                            >
                              &uarr;
                            </span>
                          );
                        } else {
                          trendEl = (
                            <span
                              className="ml-1.5 text-muted text-xs"
                              title="No change"
                            >
                              &rarr;
                            </span>
                          );
                        }
                      }

                      const passedCount = (row.module_summary || []).filter(
                        (m) => m.status === "passed"
                      ).length;

                      return (
                        <tr
                          key={row.id}
                          className="border-b border-border last:border-0 hover:bg-gray-50/50 transition-colors"
                        >
                          <td className="px-5 py-3 text-muted">
                            {timeAgo(row.scanned_at)}
                          </td>
                          <td className="px-5 py-3">
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                              {row.tier}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right font-mono font-semibold">
                            <span
                              className={
                                row.total_issues === 0
                                  ? "text-success"
                                  : row.total_issues > 50
                                    ? "text-danger"
                                    : "text-foreground"
                              }
                            >
                              {row.total_issues}
                            </span>
                            {trendEl}
                          </td>
                          <td className="px-5 py-3 text-right text-muted font-mono">
                            {row.total_modules > 0
                              ? `${passedCount}/${row.total_modules}`
                              : `${row.total_modules}`}
                          </td>
                          <td className="px-5 py-3 text-right text-muted">
                            {formatDuration(row.duration_ms)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
