"use client";

import { Suspense, useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface WebFinding {
  severity: "critical" | "warning" | "info" | "pass";
  category: string;
  title: string;
  detail: string;
  fix?: string;
}

interface FixFile {
  filename: string;
  language: string;
  content: string;
  instructions: string;
}

interface WebScanResult {
  url: string;
  finalUrl: string;
  ok: boolean;
  responseMs: number;
  statusCode: number;
  findings: WebFinding[];
  summary: {
    critical: number;
    warnings: number;
    passed: number;
    score: number;
  };
  platform?: {
    name: string;
    canAutoFix: boolean;
    fixFiles?: FixFile[];
    manualSteps?: string[];
  };
  error?: string;
}

const SEVERITY_CONFIG = {
  critical: {
    label: "Critical",
    icon: "🔴",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
    text: "text-red-400",
    badge: "bg-red-500/15 text-red-400",
  },
  warning: {
    label: "Warning",
    icon: "🟡",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    text: "text-amber-400",
    badge: "bg-amber-500/15 text-amber-400",
  },
  info: {
    label: "Info",
    icon: "🔵",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    text: "text-blue-400",
    badge: "bg-blue-500/15 text-blue-400",
  },
  pass: {
    label: "Pass",
    icon: "✅",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    text: "text-emerald-400",
    badge: "bg-emerald-500/15 text-emerald-400",
  },
};

function ScoreRing({ score }: { score: number }) {
  const color =
    score >= 80 ? "#10b981" : score >= 50 ? "#f59e0b" : "#ef4444";
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;

  return (
    <div className="relative w-28 h-28 flex items-center justify-center">
      <svg className="absolute inset-0 -rotate-90" width="112" height="112">
        <circle cx="56" cy="56" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <circle
          cx="56"
          cy="56"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div className="text-center">
        <div className="text-3xl font-bold text-white">{score}</div>
        <div className="text-[10px] text-white/40">/ 100</div>
      </div>
    </div>
  );
}

function FindingCard({ finding }: { finding: WebFinding }) {
  const [expanded, setExpanded] = useState(finding.severity === "critical");
  const cfg = SEVERITY_CONFIG[finding.severity];

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} overflow-hidden`}>
      <button
        className="w-full text-left px-4 py-3 flex items-start gap-3"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="text-base mt-0.5 shrink-0">{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${cfg.text}`}>
              {finding.title}
            </span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${cfg.badge}`}>
              {finding.category}
            </span>
          </div>
        </div>
        <span className="text-white/30 text-xs mt-0.5 shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-sm text-white/65 leading-relaxed">{finding.detail}</p>
          {finding.fix && (
            <div className="mt-2 rounded-lg bg-white/5 border border-white/8 px-3 py-2">
              <p className="text-[11px] text-white/40 font-semibold uppercase tracking-wider mb-1">How to fix</p>
              <p className="text-sm text-white/75 leading-relaxed">{finding.fix}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UrlScanInner() {
  const searchParams = useSearchParams();
  const [url, setUrl] = useState(() => searchParams.get("q") || "");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<WebScanResult | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const didAutoScan = useRef(false);

  const runScan = useCallback(async (targetUrl: string) => {
    setScanning(true);
    setResult(null);
    setApiError(null);
    try {
      const res = await fetch("/api/scan/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = (await res.json()) as WebScanResult & { error?: string };
      if (!res.ok || data.error) {
        setApiError(data.error || "Scan failed. Please try again.");
      } else {
        setResult(data);
      }
    } catch {
      setApiError("Network error. Please check your connection and try again.");
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    const q = searchParams.get("q");
    if (q && !didAutoScan.current) {
      didAutoScan.current = true;
      runScan(q);
    } else {
      inputRef.current?.focus();
    }
  }, [searchParams, runScan]);

  function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    runScan(trimmed);
  }

  const criticals = result?.findings.filter((f) => f.severity === "critical") ?? [];
  const warnings = result?.findings.filter((f) => f.severity === "warning") ?? [];
  const infos = result?.findings.filter((f) => f.severity === "info") ?? [];
  const passes = result?.findings.filter((f) => f.severity === "pass") ?? [];

  return (
    <main className="min-h-screen bg-[#0a0a12] pt-24 pb-20 px-4">
      {/* Glow */}
      <div className="pointer-events-none fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-gradient-to-b from-teal-500/8 to-transparent rounded-full blur-[120px]" />

      <div className="relative z-10 max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 text-xs font-semibold mb-5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-teal-400" />
            </span>
            Free website health check
          </div>
          <h1 className="text-4xl font-bold text-white mb-3">
            Is your website{" "}
            <span className="text-[#2dd4bf]">healthy?</span>
          </h1>
          <p className="text-white/50 text-base leading-relaxed">
            Paste any website URL. We check security, speed, SEO, mobile-friendliness,
            and accessibility — and explain every issue in plain English.
          </p>
        </div>

        {/* URL Input */}
        <form onSubmit={handleScan} className="mb-8">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mywebsite.com"
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/30 transition-all"
              disabled={scanning}
            />
            <button
              type="submit"
              disabled={scanning || !url.trim()}
              className="px-6 py-3.5 rounded-xl bg-[#2dd4bf] text-black font-semibold text-sm hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {scanning ? "Scanning…" : "Scan Now"}
            </button>
          </div>
          {apiError && (
            <p className="mt-3 text-sm text-red-400 text-center">{apiError}</p>
          )}
        </form>

        {/* Scanning indicator */}
        {scanning && (
          <div className="text-center py-16 space-y-4">
            <div className="inline-flex items-center gap-3 text-white/50">
              <svg className="animate-spin w-5 h-5 text-teal-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm">Fetching your site and running checks…</span>
            </div>
            <p className="text-xs text-white/25">Usually takes 3–8 seconds</p>
          </div>
        )}

        {/* Results */}
        {result && !scanning && (
          <div className="space-y-6 animate-fade-in">
            {/* Score header */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 flex items-center gap-6">
              <ScoreRing score={result.summary.score} />
              <div className="flex-1">
                <div className="text-white font-semibold text-lg mb-1 truncate" title={result.finalUrl}>
                  {result.finalUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  {result.summary.critical > 0 && (
                    <span className="text-red-400 font-medium">
                      🔴 {result.summary.critical} critical
                    </span>
                  )}
                  {result.summary.warnings > 0 && (
                    <span className="text-amber-400 font-medium">
                      🟡 {result.summary.warnings} warnings
                    </span>
                  )}
                  {result.summary.passed > 0 && (
                    <span className="text-emerald-400 font-medium">
                      ✅ {result.summary.passed} passed
                    </span>
                  )}
                </div>
                <div className="mt-2 text-xs text-white/30 flex flex-wrap items-center gap-3">
                  <span>{result.responseMs}ms response · HTTP {result.statusCode}{result.finalUrl !== result.url ? " · followed redirect" : ""}</span>
                  {result.platform && (
                    <span className="px-2 py-0.5 rounded-full bg-white/6 border border-white/10 text-white/50 text-[10px] font-medium">
                      {result.platform.name}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Score legend */}
            {result.summary.critical > 0 && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300 leading-relaxed">
                <strong>Your site has critical issues</strong> that could expose visitors to risk or
                harm your search ranking. Fix the red items first.
              </div>
            )}
            {result.summary.critical === 0 && result.summary.warnings > 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300 leading-relaxed">
                <strong>Looking mostly good!</strong> There are a few things worth improving
                to protect your visitors and improve your Google ranking.
              </div>
            )}
            {result.summary.critical === 0 && result.summary.warnings === 0 && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-300 leading-relaxed">
                <strong>Excellent!</strong> Your site is well-configured. No critical or
                warning-level issues found.
              </div>
            )}

            {/* Critical findings */}
            {criticals.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-white/40 uppercase tracking-widest mb-3">
                  Critical — fix these first
                </h2>
                <div className="space-y-2">
                  {criticals.map((f, i) => <FindingCard key={i} finding={f} />)}
                </div>
              </section>
            )}

            {/* Warnings */}
            {warnings.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-white/40 uppercase tracking-widest mb-3">
                  Warnings — worth fixing
                </h2>
                <div className="space-y-2">
                  {warnings.map((f, i) => <FindingCard key={i} finding={f} />)}
                </div>
              </section>
            )}

            {/* Info */}
            {infos.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-white/40 uppercase tracking-widest mb-3">
                  Notices
                </h2>
                <div className="space-y-2">
                  {infos.map((f, i) => <FindingCard key={i} finding={f} />)}
                </div>
              </section>
            )}

            {/* Passes (collapsed by default) */}
            {passes.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-sm font-semibold text-white/40 uppercase tracking-widest mb-3 list-none flex items-center gap-2 select-none">
                  <span className="group-open:hidden">▶</span>
                  <span className="hidden group-open:inline">▼</span>
                  {passes.length} checks passing
                </summary>
                <div className="mt-3 space-y-2">
                  {passes.map((f, i) => <FindingCard key={i} finding={f} />)}
                </div>
              </details>
            )}

            {/* Platform fix files — downloadable configs */}
            {result.platform?.canAutoFix && result.platform.fixFiles && result.platform.fixFiles.length > 0 && (
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-emerald-400 text-lg">⚡</span>
                  <h2 className="text-white font-semibold text-sm">
                    We generated a fix file for your {result.platform.name} site
                  </h2>
                </div>
                {result.platform.fixFiles.map((f, i) => (
                  <div key={i} className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-xs text-emerald-400 font-mono">{f.filename}</code>
                      <button
                        onClick={() => {
                          const blob = new Blob([f.content], { type: "text/plain" });
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = f.filename.split(" ")[0];
                          a.click();
                          URL.revokeObjectURL(a.href);
                        }}
                        className="text-xs px-3 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/25 transition-colors font-medium"
                      >
                        ↓ Download
                      </button>
                    </div>
                    <pre className="text-[11px] text-white/60 bg-black/30 rounded-lg p-3 overflow-x-auto leading-relaxed border border-white/5">
                      {f.content}
                    </pre>
                    <p className="mt-2 text-xs text-white/45 leading-relaxed">{f.instructions}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Manual steps for platforms where file injection isn't possible */}
            {result.platform?.manualSteps && result.platform.manualSteps.length > 0 && !result.platform.canAutoFix && (
              <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-blue-400 text-lg">🔧</span>
                  <h2 className="text-white font-semibold text-sm">
                    How to fix these issues on {result.platform.name}
                  </h2>
                </div>
                <ol className="space-y-2">
                  {result.platform.manualSteps.map((step, i) => (
                    <li key={i} className="flex gap-3 text-sm text-white/60 leading-relaxed">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-blue-500/15 text-blue-400 text-[10px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* CTA — scan a repo for deeper analysis */}
            <div className="rounded-2xl border border-teal-500/20 bg-teal-500/5 p-6 text-center">
              <p className="text-white font-semibold mb-1">
                This was a surface-level website check.
              </p>
              <p className="text-white/50 text-sm mb-4">
                If you have a GitHub repo, GateTest can scan 102 modules — security
                vulnerabilities, supply-chain risks, dependency issues, and more.
                On Scan + Fix ($199) and Nuclear ($399) we also open a fix PR automatically.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Link
                  href="/#pricing"
                  className="px-6 py-2.5 rounded-xl bg-[#2dd4bf] text-black font-semibold text-sm hover:bg-[#14b8a6] transition-colors text-center"
                >
                  Scan My GitHub Repo →
                </Link>
                <button
                  onClick={() => { setResult(null); setUrl(""); setTimeout(() => inputRef.current?.focus(), 50); }}
                  className="px-6 py-2.5 rounded-xl border border-white/12 text-white/50 font-medium text-sm hover:text-white hover:border-white/25 transition-colors"
                >
                  Scan Another URL
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty state hints */}
        {!scanning && !result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            {[
              { icon: "🔒", label: "Security headers" },
              { icon: "⚡", label: "Page speed" },
              { icon: "📱", label: "Mobile-friendly" },
              { icon: "🔍", label: "SEO essentials" },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-4">
                <div className="text-2xl mb-1">{item.icon}</div>
                <div className="text-xs text-white/40">{item.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export default function UrlScanPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-[#0a0a12] pt-24 flex items-center justify-center">
        <p className="text-white/40 text-sm">Loading…</p>
      </main>
    }>
      <UrlScanInner />
    </Suspense>
  );
}
