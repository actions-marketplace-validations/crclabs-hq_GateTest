"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import FindingsPanel from "@/app/components/FindingsPanel";
import LiveScanTerminal from "@/app/components/LiveScanTerminal";
import { extractIssuesFromModules, type UnparseableIssue } from "@/app/lib/issue-extractor";

interface ModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "pending" | "running";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

interface FixableIssue {
  file: string;
  issue: string;
  module: string;
}

interface ScanResult {
  status: "complete" | "failed" | "expired";
  modules: ModuleResult[];
  totalModules: number;
  completedModules: number;
  totalIssues: number;
  totalFixed: number;
  duration: number;
  repoUrl?: string;
  tier?: string;
  error?: string;
  canRetry?: boolean;
  fixableIssues?: FixableIssue[];
}

interface FixResult {
  status: string;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  filesFixed?: number;
  issuesFixed?: number;
  message?: string;
  error?: string;
  errors?: string[];
  failedFiles?: Array<{ file: string; issues: string[]; reason: string }>;
}

const MODULE_LABELS: Record<string, string> = {
  syntax: "Syntax validation",
  lint: "Linting checks",
  secrets: "Secret detection",
  codeQuality: "Code quality",
  security: "Security scan",
  accessibility: "Accessibility audit",
  seo: "SEO validation",
  links: "Link checking",
  compatibility: "Compatibility",
  dataIntegrity: "Data integrity",
  documentation: "Documentation",
  performance: "Performance",
  aiReview: "AI code review",
  fakeFixDetector: "Fake-fix detector",
  dependencyFreshness: "Dependency freshness",
  maliciousDeps: "Malicious deps (supply-chain)",
  licenses: "License compliance",
  iacSecurity: "IaC security (Docker/K8s/TF)",
  ciHardening: "CI/CD hardening",
  migrations: "SQL migration safety",
  authFlaws: "Auth flaws",
  flakyTests: "Flaky-test detector",
};

export default function ScanStatus() {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [animModules, setAnimModules] = useState<ModuleResult[]>([]);
  const [animIndex, setAnimIndex] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fixError, setFixError] = useState("");
  const startTimeRef = useRef(Date.now());
  const scanTriggered = useRef(false);
  const fixTriggered = useRef(false);

  const [params, setParams] = useState<{ id: string; repo: string; tier: string }>({ id: "", repo: "", tier: "quick" });

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setParams({
      id: sp.get("session_id") || sp.get("id") || "",
      repo: sp.get("repo") || decodeURIComponent(sp.get("repo_url") || ""),
      tier: sp.get("tier") || "quick",
    });
  }, []);

  // Timer
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [scanning]);

  // Setup animation modules
  useEffect(() => {
    if (!params.tier) return;
    const names = params.tier === "quick"
      ? ["syntax", "lint", "secrets", "codeQuality"]
      : ["syntax", "lint", "secrets", "codeQuality", "security", "accessibility",
         "seo", "links", "compatibility", "dataIntegrity", "documentation",
         "performance", "aiReview", "fakeFixDetector", "dependencyFreshness",
         "maliciousDeps", "licenses", "iacSecurity", "ciHardening",
         "migrations", "authFlaws", "flakyTests"];
    setAnimModules(names.map((n) => ({ name: n, status: "pending" as const, checks: 0, issues: 0, duration: 0 })));
  }, [params.tier]);

  // Animate modules
  useEffect(() => {
    if (!scanning || animModules.length === 0 || scanResult) return;
    const t = setInterval(() => {
      setAnimIndex((prev) => {
        const next = prev + 1;
        if (next >= animModules.length) return prev;
        setAnimModules((mods) =>
          mods.map((m, i) => ({
            ...m,
            status: i < next ? "passed" : i === next ? "running" : "pending",
            checks: i < next ? 5 + i * 3 : 0,
            duration: i < next ? 80 + i * 40 : 0,
          }))
        );
        return next;
      });
    }, 1200);
    return () => clearInterval(t);
  }, [scanning, animModules.length, scanResult]);

  // Trigger scan
  useEffect(() => {
    if (scanTriggered.current) return;

    if (!params.repo && params.id) {
      fetch(`/api/scan/status?id=${params.id}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.repoUrl) {
            setParams((p) => ({ ...p, repo: data.repoUrl, tier: data.tier || p.tier }));
          } else {
            setScanResult({ status: "failed", modules: [], totalModules: 0, completedModules: 0, totalIssues: 0, totalFixed: 0, duration: 0, error: "No repository URL found" });
            setScanning(false);
          }
        })
        .catch(() => {
          setScanResult({ status: "failed", modules: [], totalModules: 0, completedModules: 0, totalIssues: 0, totalFixed: 0, duration: 0, error: "Could not load session" });
          setScanning(false);
        });
      return;
    }

    if (!params.repo) return;
    scanTriggered.current = true;

    fetch("/api/scan/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: params.id, repoUrl: params.repo, tier: params.tier }),
    })
      .then((res) => res.json())
      .then((data) => {
        // Normalise any status the UI doesn't render (pending, running,
        // cancelled, unexpected) into a failed result so the user never
        // sees a page stuck at 100% with a misleading "Scanning..." header.
        const knownStates = new Set(["complete", "failed", "expired"]);
        if (!data || !knownStates.has(data.status)) {
          setScanResult({
            status: "failed",
            modules: data?.modules || [],
            totalModules: data?.totalModules || 0,
            completedModules: data?.completedModules || 0,
            totalIssues: data?.totalIssues || 0,
            totalFixed: data?.totalFixed || 0,
            duration: data?.duration || 0,
            error: data?.error || `Scan returned unexpected state: ${data?.status || "none"}`,
          });
        } else {
          setScanResult(data);
        }
        setScanning(false);
      })
      .catch((err) => {
        setScanResult({ status: "failed", modules: [], totalModules: 0, completedModules: 0, totalIssues: 0, totalFixed: 0, duration: 0, error: err.message });
        setScanning(false);
      });
  }, [params]);

  const formatTime = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, "0")}s` : `${s}s`;

  // Parse failed-module details into the {file, issue, module} shape that
  // /api/scan/fix expects. Delegates to the shared helper at
  // `website/app/lib/issue-extractor.ts` so the customer page and the admin
  // Command Center cannot drift apart again. The helper also returns a
  // separate `unparseable` list so findings without a parseable file
  // location are surfaced honestly to the customer instead of being
  // silently filtered out.
  function extractFixableIssues(modules: ModuleResult[]) {
    return extractIssuesFromModules(modules).fixable;
  }

  function extractUnparseableIssues(modules: ModuleResult[]): UnparseableIssue[] {
    return extractIssuesFromModules(modules).unparseable;
  }

  async function runFix() {
    if (!scanResult || !params.repo) return;
    const { fixable: issues } = extractIssuesFromModules(scanResult.modules);
    if (issues.length === 0) {
      setFixError("No auto-fixable issues — these need manual review (config / infrastructure / architectural).");
      return;
    }
    setFixing(true);
    setFixResult(null);
    setFixError("");
    try {
      const res = await fetch("/api/scan/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: params.repo, issues, tier: params.tier || "full" }),
      });
      const data = await res.json() as FixResult;
      setFixResult(data);
    } catch (err) {
      setFixError(err instanceof Error ? err.message : "Fix failed");
    } finally {
      setFixing(false);
    }
  }

  // Auto-trigger fix once the scan completes with fixable issues — ONLY
  // for paid fix-tiers (scan_fix / nuclear). Quick ($29) and Full ($99)
  // are scan-only tiers; their fix-phase is an upgrade, not an entitlement.
  // Auto-triggering for them gave away $199 Scan+Fix work for $29.
  useEffect(() => {
    if (fixTriggered.current) return;
    if (scanResult?.status !== "complete") return;
    if ((scanResult.totalIssues || 0) === 0) return;
    if (extractFixableIssues(scanResult.modules).length === 0) return;
    // Gate: only Scan+Fix ($199) and Nuclear ($399) get the auto-fix.
    if (params.tier !== "scan_fix" && params.tier !== "nuclear") return;
    fixTriggered.current = true;
    runFix();
  }, [scanResult, params.tier]); // eslint-disable-line react-hooks/exhaustive-deps


  const isComplete = scanResult?.status === "complete";
  const isFailed = scanResult?.status === "failed";
  const isExpired = scanResult?.status === "expired";
  const isEndState = isComplete || isFailed || isExpired;
  const displayModules = scanResult ? scanResult.modules : animModules;
  const displayProgress = scanResult ? 100 : Math.min(Math.round((animIndex / Math.max(animModules.length, 1)) * 95) + 5, 95);

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <div className={`${isComplete && (scanResult?.totalIssues || 0) > 0 ? "max-w-4xl" : "max-w-3xl"} mx-auto transition-all duration-300`}>
        {/* Header */}
        <div className="text-center mb-8">
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium mb-5 ${
            isComplete ? "bg-green-50 border border-green-200 text-green-700" :
            isExpired ? "bg-slate-50 border border-slate-200 text-slate-700" :
            isFailed ? "bg-amber-50 border border-amber-200 text-amber-700" :
            "bg-amber-50 border border-amber-200 text-amber-700"
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              isComplete ? "bg-green-500" :
              isExpired ? "bg-slate-400" :
              isFailed ? "bg-amber-500" : "bg-amber-500 animate-pulse"
            }`} />
            {isComplete ? "Scan Complete" :
             isExpired ? "Session Expired" :
             isFailed ? "Scan Failed" : "Scanning..."}
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold mb-3 text-foreground">
            {isComplete ? (
              (scanResult?.totalIssues || 0) === 0
                ? "All Clear"
                : `${scanResult?.totalIssues} Issue${(scanResult?.totalIssues || 0) > 1 ? "s" : ""} Found`
            ) : isExpired ? "Session Expired" :
               isFailed ? "Scan Failed" : "Scanning..."}
          </h1>

          {params.repo && (
            <p className="text-sm text-muted font-mono">{params.repo}</p>
          )}
        </div>

        {/* Progress */}
        <div className="mb-8">
          <div className="flex justify-between items-center text-sm mb-2">
            <span className="text-muted">{scanResult ? `${scanResult.completedModules} modules` : `Module ${animIndex + 1} of ${animModules.length}`}</span>
            <span className="font-bold text-accent">{displayProgress}%</span>
            <span className="text-muted font-mono">{formatTime(elapsed)}</span>
          </div>
          <div className="w-full h-2 bg-surface-dark rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-700 ${scanning ? "progress-glow" : ""}`}
              style={{
                width: `${displayProgress}%`,
                background: isComplete
                  ? (scanResult?.totalIssues || 0) === 0 ? "#059669" : "#059669"
                  : isFailed ? "#059669" : "#059669",
              }} />
          </div>
        </div>

        {/* Live terminal — visible during scan */}
        {scanning && params.repo && (
          <div className="mb-8">
            <LiveScanTerminal
              repoUrl={params.repo}
              tier={params.tier}
              sessionId={params.id}
              onComplete={(data) => {
                setScanResult(data as unknown as ScanResult);
                setScanning(false);
              }}
              onError={(err) => {
                setScanResult({
                  status: "failed",
                  modules: [],
                  totalModules: 0,
                  completedModules: 0,
                  totalIssues: 0,
                  totalFixed: 0,
                  duration: 0,
                  error: err,
                });
                setScanning(false);
              }}
            />
          </div>
        )}

        {/* Module list — clean cards, not terminal */}
        <div className="space-y-2 mb-8">
          {displayModules.map((mod) => {
            const label = MODULE_LABELS[mod.name] || mod.name;
            return (
              <div key={mod.name}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                  mod.status === "passed" ? "bg-white border-green-100" :
                  mod.status === "failed" ? "bg-amber-50/50 border-amber-200" :
                  mod.status === "running" ? "bg-amber-50/50 border-amber-200" :
                  mod.status === "skipped" ? "bg-slate-50 border-slate-200" :
                  "bg-surface-dark border-border opacity-50"
                } ${mod.status !== "pending" ? "slide-in" : ""}`}>

                {/* Status icon */}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold ${
                  mod.status === "passed" ? "bg-green-100 text-green-600" :
                  mod.status === "failed" ? "bg-amber-100 text-amber-600" :
                  mod.status === "running" ? "bg-amber-100 text-amber-600" :
                  mod.status === "skipped" ? "bg-slate-100 text-slate-500" :
                  "bg-surface-dark text-muted"
                }`}>
                  {mod.status === "passed" ? "✓" :
                   mod.status === "failed" ? "!" :
                   mod.status === "skipped" ? "–" :
                   mod.status === "running" ? <span className="w-3 h-3 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" /> :
                   "○"}
                </div>

                {/* Module name */}
                <div className="flex-1 min-w-0">
                  <span className={`font-medium text-sm ${
                    mod.status === "passed" ? "text-foreground" :
                    mod.status === "failed" ? "text-amber-700" :
                    mod.status === "running" ? "text-amber-700" :
                    mod.status === "skipped" ? "text-slate-600" :
                    "text-muted"
                  }`}>{label}</span>

                  {/* Issue details inline */}
                  {mod.status === "failed" && mod.details && mod.details.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {mod.details.map((d, i) => (
                        <p key={i} className="text-xs text-amber-500 font-mono truncate">{d}</p>
                      ))}
                    </div>
                  )}
                  {mod.status === "skipped" && mod.skipped && (
                    <p className="mt-1 text-xs text-slate-500 truncate">{mod.skipped}</p>
                  )}
                </div>

                {/* Right side info */}
                <div className="text-right shrink-0">
                  {mod.status === "passed" && (
                    <span className="text-xs text-muted">{mod.checks} checks &middot; {mod.duration}ms</span>
                  )}
                  {mod.status === "failed" && (
                    <span className="text-xs font-semibold text-amber-600">{mod.issues} issue{mod.issues > 1 ? "s" : ""}</span>
                  )}
                  {mod.status === "skipped" && (
                    <span className="text-xs font-semibold text-slate-500">SKIPPED</span>
                  )}
                  {mod.status === "running" && (
                    <span className="text-xs text-amber-600 animate-pulse">scanning...</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-8">
          {[
            { value: scanResult?.completedModules || animIndex, label: "Modules", color: "text-accent" },
            { value: scanResult?.totalIssues || 0, label: "Issues", color: (scanResult?.totalIssues || 0) > 0 ? "text-accent" : "text-foreground" },
            { value: scanResult?.totalFixed || 0, label: "Fixed", color: "text-success" },
            { value: formatTime(elapsed), label: "Time", color: "text-foreground" },
          ].map((stat) => (
            <div key={stat.label} className="text-center p-4 rounded-xl card">
              <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
              <div className="text-xs text-muted mt-1">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Completion section */}
        {isComplete && (
          <div className="space-y-4">
            {/* Result summary */}
            <div className={`p-5 rounded-xl border ${
              (scanResult?.totalIssues || 0) === 0
                ? "bg-green-50 border-green-200"
                : "bg-amber-50 border-amber-200"
            }`}>
              <p className="font-bold text-foreground">
                {(scanResult?.totalIssues || 0) === 0
                  ? "Your code passed all checks."
                  : `${scanResult?.totalIssues} issue${(scanResult?.totalIssues || 0) > 1 ? "s" : ""} need attention.`}
              </p>
              <p className="text-sm text-muted mt-1">
                {scanResult?.completedModules} modules scanned in {scanResult?.duration}ms
              </p>
            </div>

            {/* Beautiful findings panel — severity, file:line, filter, search */}
            {scanResult && scanResult.modules.length > 0 && (
              <FindingsPanel modules={scanResult.modules} repoUrl={params.repo} />
            )}

            {/* Manual-review surfacing — findings whose file location couldn't
                be parsed go HERE rather than being silently dropped. The
                customer sees the honest delivery scope: what we will auto-fix
                vs. what they need to triage themselves. */}
            {scanResult && extractUnparseableIssues(scanResult.modules).length > 0 && (
              <div className="p-5 rounded-xl border border-slate-200 bg-slate-50">
                <h3 className="font-bold text-foreground mb-1">
                  {extractUnparseableIssues(scanResult.modules).length} issue
                  {extractUnparseableIssues(scanResult.modules).length > 1 ? "s" : ""} need manual review
                </h3>
                <p className="text-xs text-muted mb-3">
                  No file location could be parsed from the finding text — these
                  won&apos;t be in the auto-fix PR. Triage manually:
                </p>
                <ul className="space-y-1 text-xs font-mono text-slate-700 max-h-48 overflow-auto">
                  {extractUnparseableIssues(scanResult.modules).map((u, i) => (
                    <li key={i} className="truncate">
                      <span className="text-slate-500">[{u.module}]</span> {u.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* What's next — AI fix CTA. Only paid fix-tiers (scan_fix /
                nuclear) get the "Fix with AI" button. Quick / Full are
                scan-only tiers; they see an upgrade card instead. */}
            {(scanResult?.totalIssues || 0) > 0 && (params.tier === "scan_fix" || params.tier === "nuclear") && (
              <div className="p-5 rounded-xl border border-border bg-white">
                <h3 className="font-bold text-foreground mb-2">Or let GateTest fix it for you</h3>
                <p className="text-sm text-muted mb-4">
                  Skip the copy-paste — Claude reads each finding, generates the fix, re-validates against the scanner, writes a regression test, and opens a pull request on your repo. Included with your {params.tier === "nuclear" ? "Nuclear" : "Scan + Fix"} tier.
                </p>

                {!fixResult && !fixing && (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <button
                      onClick={runFix}
                      className="btn-primary px-6 py-3 text-sm text-center"
                      style={{ background: "#059669" }}
                    >
                      Fix {scanResult?.totalIssues} Issue{(scanResult?.totalIssues || 0) > 1 ? "s" : ""} with AI
                    </button>
                    <Link href="/#pricing" className="btn-secondary px-6 py-3 text-sm text-center">
                      Scan Another Repo
                    </Link>
                  </div>
                )}

                {fixing && (
                  <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-50 border border-amber-200">
                    <span className="w-4 h-4 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800">Claude is reading your code and generating fixes…</p>
                      <p className="text-xs text-amber-700 mt-0.5">Typically 30&ndash;90 seconds. Each fix is re-scanned before commit.</p>

                    </div>
                  </div>
                )}

                {fixError && (
                  <p className="mt-3 text-sm text-amber-700">{fixError}</p>
                )}

                {fixResult && (
                  <div className={`mt-3 p-4 rounded-lg border ${fixResult.prUrl ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
                    {fixResult.prUrl ? (
                      <>
                        <p className="text-sm font-bold text-green-800 mb-1">
                          ✓ Pull request opened &mdash; {fixResult.issuesFixed} issue{(fixResult.issuesFixed || 0) > 1 ? "s" : ""} fixed across {fixResult.filesFixed} file{(fixResult.filesFixed || 0) > 1 ? "s" : ""}
                        </p>
                        <p className="text-xs text-green-700 mb-3">
                          Fixes are on branch <code className="font-mono">{fixResult.branch}</code>. Your main branch is unchanged until you merge.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <a
                            href={fixResult.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-primary px-5 py-2.5 text-sm text-center"
                            style={{ background: "#059669" }}
                          >
                            View pull request &rarr;
                          </a>
                          <button
                            onClick={runFix}
                            className="btn-secondary px-5 py-2.5 text-sm text-center"
                            disabled={fixing}
                          >
                            Re-fix
                          </button>
                        </div>
                        {fixResult.errors && fixResult.errors.length > 0 && (
                          <details className="mt-3 text-xs text-green-800/80">
                            <summary className="cursor-pointer font-medium">{fixResult.errors.length} item{fixResult.errors.length > 1 ? "s" : ""} could not be auto-fixed</summary>
                            <ul className="mt-2 space-y-0.5 pl-3 list-disc">
                              {fixResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                            </ul>
                          </details>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-bold text-amber-800">{fixResult.error || fixResult.message || "Fix could not complete"}</p>
                        {fixResult.errors && fixResult.errors.length > 0 && (
                          <ul className="mt-2 text-xs text-amber-700 space-y-0.5">
                            {fixResult.errors.slice(0, 5).map((e, i) => <li key={i}>&rarr; {e}</li>)}
                          </ul>
                        )}
                        <button
                          onClick={runFix}
                          className="mt-3 btn-secondary px-4 py-2 text-sm"
                          disabled={fixing}
                        >
                          Try again
                        </button>
                      </>

                    )}
                  </div>
                )}

              </div>
            )}

            {/* Upgrade card for Quick / Full customers (scan-only tiers). */}
            {(scanResult?.totalIssues || 0) > 0 && (params.tier === "quick" || params.tier === "full") && (
              <div className="p-6 rounded-xl border-2 border-accent/30 bg-accent/5">
                <h3 className="font-bold text-foreground mb-2 text-lg">Want these fixed automatically?</h3>
                <p className="text-sm text-muted mb-5">
                  Your <span className="font-semibold">{params.tier === "quick" ? "Quick" : "Full"}</span> scan delivered the findings. The AI auto-fix — Claude reads each one, generates the fix, writes a regression test, and opens a pull request on your repo — is included with the Scan + Fix and Nuclear tiers.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {params.tier === "quick" && (
                    <Link
                      href="/#pricing"
                      className="p-4 rounded-lg border border-border bg-white hover:border-accent/40 transition-colors block"
                    >
                      <p className="font-semibold text-foreground mb-1">Full Scan — $99</p>
                      <p className="text-xs text-muted">See findings in all 102 modules (not just 4). Same scan-only delivery, full coverage.</p>
                    </Link>
                  )}
                  <Link
                    href="/#pricing"
                    className="p-4 rounded-lg border-2 border-accent bg-white hover:bg-accent/5 transition-colors block"
                  >
                    <p className="font-semibold text-foreground mb-1">Scan + Fix — $199</p>
                    <p className="text-xs text-muted">All 102 modules + AI opens a pull request with the fixes + regression tests + pair-review.</p>
                  </Link>
                  <Link
                    href="/#pricing"
                    className={`p-4 rounded-lg border border-border bg-white hover:border-accent/40 transition-colors block ${params.tier === "full" ? "" : "sm:col-span-1"}`}
                  >
                    <p className="font-semibold text-foreground mb-1">Nuclear — $399</p>
                    <p className="text-xs text-muted">Scan + Fix + Claude diagnosis per finding + attack-chain correlation + board-ready CISO report.</p>
                  </Link>
                </div>
                <p className="mt-4 text-xs text-muted">Pay-on-completion via Stripe. Card hold only — released if the scan can&apos;t complete.</p>
              </div>
            )}

            {(scanResult?.totalIssues || 0) === 0 && (
              <div className="p-5 rounded-xl border border-border bg-white text-center">
                <p className="text-sm text-muted mb-4">
                  {params.tier === "quick"
                    ? "Passed the Quick Scan. Want to go deeper with all 102 modules?"
                    : "Clean across all 102 modules."}

                </p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  {params.tier === "quick" && (
                    <Link href="/#pricing" className="btn-primary px-6 py-3 text-sm text-center">
                      Run Full Scan — $99
                    </Link>
                  )}
                  <Link href="/#pricing" className="btn-secondary px-6 py-3 text-sm text-center">
                    Scan Another Repo
                  </Link>
                </div>
              </div>
            )}

            {/* Save & access later */}
            <div className="p-4 rounded-xl border border-border bg-background-alt text-center">
              <p className="text-sm text-muted">
                Bookmark this page to revisit your results, or view all your scans at{" "}
                <Link href="/dashboard" className="text-accent font-medium hover:underline">My Scans</Link>.
              </p>
            </div>

            {/* Branding */}
            <p className="text-center text-xs text-muted pt-2">
              Scanned by GateTest &middot; gatetest.ai
            </p>
          </div>
        )}

        {/* Session expired — checkout session cancelled before scan started */}
        {isExpired && (
          <div className="text-center">
            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 mb-4">
              <p className="font-bold text-slate-700">{scanResult?.error || "This checkout session expired."}</p>
              <p className="text-sm text-muted mt-1">No charge was made. Start a new scan when you&apos;re ready.</p>
            </div>
            <Link href="/#pricing" className="btn-primary px-6 py-3 text-sm">Start New Scan</Link>
          </div>
        )}

        {/* Failed — scan ran but something went wrong */}
        {isFailed && (
          <div className="text-center">
            <div className="p-5 rounded-xl bg-amber-50 border border-amber-200 mb-4">
              <p className="font-bold text-amber-700">{scanResult?.error || "Scan failed"}</p>
              <p className="text-sm text-muted mt-1">No charge was made. Card hold released.</p>
            </div>
            <Link href="/#pricing" className="btn-primary px-6 py-3 text-sm">Try Again</Link>
          </div>
        )}

        {/* Scanning notice */}
        {scanning && !isEndState && (
          <p className="text-center text-xs text-muted mt-4">
            Card held, not charged. Payment captured only after scan delivery.
          </p>
        )}
      </div>
    </div>
  );
}
