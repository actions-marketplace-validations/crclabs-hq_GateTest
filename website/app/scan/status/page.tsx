"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";

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
  // Phase 1.2b: per-module findings map returned by /api/scan/run so
  // the fix API can run the cross-scanner re-validation gate.
  findingsByModule?: Record<string, string[]>;
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
  // Phase 6.1.3 — DiffViewer source data
  fixes?: Array<{ file: string; issues: string[]; before?: string; after?: string }>;
  // Phase 1.2b — cross-scanner re-validation gate results
  scannerGate?: {
    rolledBack?: Array<{ file: string; reason: string; newFindings: string[] }>;
    summary?: string;
    skipped?: boolean;
    reason?: string;
  };
}

const MODULE_LABELS: Record<string, string> = {
  syntax: "Syntax",
  lint: "Lint",
  secrets: "Secret detection",
  codeQuality: "Code quality",
  security: "Security",
  accessibility: "Accessibility",
  seo: "SEO",
  links: "Links",
  compatibility: "Compatibility",
  dataIntegrity: "Data integrity",
  documentation: "Documentation",
  performance: "Performance",
  aiReview: "AI code review",
  fakeFixDetector: "Fake-fix detector",
  dependencyFreshness: "Dependencies",
  maliciousDeps: "Supply chain",
  licenses: "Licenses",
  iacSecurity: "IaC / Dockerfile",
  ciHardening: "CI hardening",
  migrations: "SQL migrations",
  authFlaws: "Auth flaws",
  flakyTests: "Flaky tests",
};

function severityOf(detail: string): "critical" | "high" | "medium" | "low" {
  const d = detail.toLowerCase();
  if (d.includes("critical") || d.includes("secret") || d.includes("hardcoded") || d.includes("sql injection") || d.includes("rce")) return "critical";
  if (d.includes("error") || d.includes("security") || d.includes("auth") || d.includes("vuln")) return "high";
  if (d.includes("warning") || d.includes("deprecated") || d.includes("missing")) return "medium";
  return "low";
}

function SeverityBadge({ sev }: { sev: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    critical: { label: "CRITICAL", cls: "bg-red-500/20 text-red-400 border border-red-500/30" },
    high: { label: "HIGH", cls: "bg-orange-500/20 text-orange-400 border border-orange-500/30" },
    medium: { label: "MEDIUM", cls: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" },
    low: { label: "LOW", cls: "bg-blue-500/20 text-blue-400 border border-blue-500/30" },
  };
  const c = cfg[sev] || cfg.low;
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono tracking-wider ${c.cls}`}>{c.label}</span>;
}

function ScanningState({ repo, tier, animModules, animIndex, elapsed }: {
  repo: string; tier: string;
  animModules: ModuleResult[]; animIndex: number; elapsed: number;
}) {
  const formatTime = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, "0")}s` : `${s}s`;
  const progress = Math.min(Math.round((animIndex / Math.max(animModules.length, 1)) * 92) + 5, 92);
  const repoShort = repo.replace(/^https?:\/\/(www\.)?github\.com\//, "");

  return (
    <div className="min-h-screen flex flex-col items-center justify-start pt-16 pb-16 px-4" style={{ background: "#080b14" }}>
      {/* Top brand */}
      <div className="mb-12 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "rgba(45,212,191,0.15)", border: "1px solid rgba(45,212,191,0.3)" }}>
          <span className="font-bold text-teal-400 font-mono text-sm">G</span>
        </div>
        <span className="text-white/40 text-sm font-medium tracking-wide">GATETEST</span>
        <span className="text-white/20 text-xs">·</span>
        <span className="text-white/30 text-xs font-mono">{tier.toUpperCase()} SCAN</span>
      </div>

      {/* Hero status */}
      <div className="text-center mb-10 w-full max-w-2xl">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mb-5"
          style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
          Scanning in progress
        </div>
        <h1 className="text-3xl font-bold text-white mb-2">
          Analysing your codebase…
        </h1>
        <p className="text-white/40 font-mono text-sm truncate max-w-lg mx-auto">{repoShort || repo}</p>
      </div>

      {/* Progress */}
      <div className="w-full max-w-2xl mb-8">
        <div className="flex justify-between text-xs text-white/30 mb-2 font-mono">
          <span>{animIndex > 0 ? `Module ${Math.min(animIndex, animModules.length)} of ${animModules.length}` : "Initialising…"}</span>
          <span className="text-teal-400 font-semibold">{progress}%</span>
          <span>{formatTime(elapsed)}</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div className="h-full rounded-full transition-all duration-700 relative"
            style={{ width: `${progress}%`, background: "linear-gradient(90deg, #0d9488, #2dd4bf)" }}>
            <div className="absolute right-0 top-0 h-full w-8 rounded-full blur-sm" style={{ background: "#2dd4bf" }} />
          </div>
        </div>
      </div>

      {/* Module grid */}
      <div className="w-full max-w-2xl grid grid-cols-2 sm:grid-cols-3 gap-2 mb-8">
        {animModules.map((mod) => {
          const label = MODULE_LABELS[mod.name] || mod.name;
          return (
            <div key={mod.name} className={`flex items-center gap-2 px-3 py-2.5 rounded-lg transition-all duration-300 ${
              mod.status === "passed" ? "opacity-100" :
              mod.status === "running" ? "opacity-100" :
              "opacity-30"
            }`} style={{
              background: mod.status === "passed" ? "rgba(16,185,129,0.08)" :
                          mod.status === "running" ? "rgba(251,191,36,0.1)" :
                          "rgba(255,255,255,0.03)",
              border: mod.status === "passed" ? "1px solid rgba(16,185,129,0.2)" :
                      mod.status === "running" ? "1px solid rgba(251,191,36,0.25)" :
                      "1px solid rgba(255,255,255,0.06)",
            }}>
              <span className="shrink-0 text-xs">
                {mod.status === "passed" ? "✓" :
                 mod.status === "running" ? <span className="inline-block w-2.5 h-2.5 border border-yellow-400 border-t-transparent rounded-full animate-spin" /> :
                 "○"}
              </span>
              <span className={`text-xs font-medium truncate ${
                mod.status === "passed" ? "text-emerald-400" :
                mod.status === "running" ? "text-yellow-400" :
                "text-white/25"
              }`}>{label}</span>
              {mod.status === "passed" && mod.duration > 0 && (
                <span className="text-white/20 text-[10px] font-mono ml-auto shrink-0">{mod.duration}ms</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      <p className="text-white/20 text-xs text-center">Card held — charged only after scan delivery</p>
    </div>
  );
}

export default function ScanStatus() {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [animModules, setAnimModules] = useState<ModuleResult[]>([]);
  const [animIndex, setAnimIndex] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fixError, setFixError] = useState("");
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [scanning]);

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
      body: JSON.stringify({ sessionId: params.id, repoUrl: params.repo, tier: params.tier || "full" }),
    })
      .then((res) => res.json())
      .then((data) => {
        const knownStates = new Set(["complete", "failed", "expired"]);
        if (!data || !knownStates.has(data.status)) {
          setScanResult({ status: "failed", modules: data?.modules || [], totalModules: data?.totalModules || 0, completedModules: data?.completedModules || 0, totalIssues: data?.totalIssues || 0, totalFixed: data?.totalFixed || 0, duration: data?.duration || 0, error: data?.error || `Scan returned unexpected state: ${data?.status || "none"}` });
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

  function extractFixableIssues(modules: ModuleResult[]) {
    const failed = modules.filter((m) => m.status === "failed");
    return failed.flatMap((m) => {
      const details = m.details || [];
      return details.map((d) => {
        let file = "";
        let issue = d;
        const fileLineMatch = d.match(/^([\w./\-@+]+?\.[\w]{1,8}):(\d+)(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
        if (fileLineMatch) { file = fileLineMatch[1]; issue = fileLineMatch[3]; }
        else {
          const fileOnly = d.match(/^([\w./\-@+]+?\.[\w]{1,8})\s*[:—-]\s*(.+)$/);
          if (fileOnly) { file = fileOnly[1]; issue = fileOnly[2]; }
        }
        const missingMatch = d.match(/(?:missing|no|needs)\s+([.\w/\-]+\.(?:md|json|yml|yaml|toml|gitignore|env|example))/i);
        if (!file && missingMatch) {
          file = missingMatch[1].toLowerCase() === "gitignore" ? ".gitignore" : missingMatch[1];
          issue = `CREATE_FILE: ${d}`;
        }
        return { file, issue, module: m.name };
      }).filter((i) => i.file);
    });
  }

  async function runFix() {
    if (!scanResult || !params.repo) return;
    const issues = extractFixableIssues(scanResult.modules);
    if (issues.length === 0) {
      setFixError("No auto-fixable issues found — these need manual review (config / infrastructure / architectural changes).");
      return;
    }
    setFixing(true);
    setFixResult(null);
    setFixError("");
    try {
      const res = await fetch("/api/scan/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: params.repo,
          issues,
          tier: params.tier || "full",
          // Phase 1.2b: pass the pre-fix findings baseline so the fix API
          // can run the cross-scanner re-validation gate. The gate diffs
          // post-fix findings against this to detect new regressions.
          originalFindingsByModule: scanResult?.findingsByModule || {},
        }),
      });
      const data = await res.json() as FixResult;
      setFixResult(data);
    } catch (err) {
      setFixError(err instanceof Error ? err.message : "Fix failed");
    } finally {
      setFixing(false);
    }
  }

  useEffect(() => {
    if (fixTriggered.current) return;
    if (scanResult?.status !== "complete") return;
    if ((scanResult.totalIssues || 0) === 0) return;
    if (extractFixableIssues(scanResult.modules).length === 0) return;
    fixTriggered.current = true;
    runFix();
  }, [scanResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const isComplete = scanResult?.status === "complete";
  const isFailed = scanResult?.status === "failed";
  const isExpired = scanResult?.status === "expired";
  const repoShort = params.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "");
  const formatTime = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, "0")}s` : `${s}s`;

  // Show scanning animation while scan is in flight
  if (scanning && !isComplete && !isFailed && !isExpired) {
    return (
      <ScanningState
        repo={params.repo}
        tier={params.tier}
        animModules={animModules}
        animIndex={animIndex}
        elapsed={elapsed}
      />
    );
  }

  // ── COMPLETE ──────────────────────────────────────────────────────────────
  if (isComplete && scanResult) {
    const hasIssues = (scanResult.totalIssues || 0) > 0;
    const failedModules = scanResult.modules.filter((m) => m.status === "failed");
    const allDetails = failedModules.flatMap((m) => (m.details || []).map((d) => ({ text: d, module: m.name, sev: severityOf(d) })));
    const critCount = allDetails.filter((d) => d.sev === "critical").length;
    const highCount = allDetails.filter((d) => d.sev === "high").length;
    const medCount = allDetails.filter((d) => d.sev === "medium").length;
    const lowCount = allDetails.filter((d) => d.sev === "low").length;

    return (
      <div className="min-h-screen" style={{ background: "#080b14" }}>
        {/* Nav bar */}
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(45,212,191,0.15)", border: "1px solid rgba(45,212,191,0.3)" }}>
              <span className="font-bold text-teal-400 font-mono text-xs">G</span>
            </div>
            <span className="text-white/50 text-sm font-medium">GateTest</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-white/30 font-mono">
            <span>{scanResult.completedModules} modules</span>
            <span>·</span>
            <span>{formatTime(elapsed)}</span>
            <span>·</span>
            <span className="truncate max-w-[200px] hidden sm:block">{repoShort}</span>
          </div>
        </div>

        <div className="max-w-4xl mx-auto px-4 py-12">

          {/* ── PR CREATED — the big moment ── */}
          {fixResult?.prUrl && (
            <div className="mb-10 rounded-2xl p-6 sm:p-8 relative overflow-hidden"
              style={{ background: "linear-gradient(135deg, rgba(5,150,105,0.15), rgba(16,185,129,0.08))", border: "1px solid rgba(16,185,129,0.35)" }}>
              {/* Glow */}
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-64 h-24 rounded-full blur-3xl pointer-events-none" style={{ background: "rgba(16,185,129,0.2)" }} />
              <div className="relative">
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
                        <span className="text-white text-xs font-bold">✓</span>
                      </div>
                      <span className="text-emerald-400 text-xs font-semibold tracking-wider uppercase">Pull Request Opened</span>
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-bold text-white">
                      {fixResult.issuesFixed} issue{(fixResult.issuesFixed || 0) > 1 ? "s" : ""} fixed across {fixResult.filesFixed} file{(fixResult.filesFixed || 0) > 1 ? "s" : ""}
                    </h2>
                    <p className="text-white/50 text-sm mt-1">
                      Branch <code className="font-mono text-teal-400">{fixResult.branch}</code> — your main branch is unchanged until you merge
                    </p>
                  </div>
                  <div className="shrink-0 hidden sm:flex items-center gap-2">
                    <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                      <span className="text-2xl">🎉</span>
                    </div>
                  </div>
                </div>

                <a href={fixResult.prUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-7 py-4 rounded-xl font-bold text-sm"
                  style={{ background: "#059669", color: "white" }}>
                  View Pull Request on GitHub &nbsp;&rarr;
                </a>

                {(scanResult.totalIssues - (fixResult.issuesFixed || 0)) > 0 && (
                  <p className="mt-4 text-white/40 text-sm">
                    <span className="text-amber-400">{scanResult.totalIssues - (fixResult.issuesFixed || 0)} issue{(scanResult.totalIssues - (fixResult.issuesFixed || 0)) > 1 ? "s" : ""}</span> need manual review — architectural or config changes AI can&apos;t make automatically
                  </p>
                )}

                {fixResult.errors && fixResult.errors.length > 0 && (
                  <details className="mt-3">
                    <summary className="text-white/30 text-xs cursor-pointer hover:text-white/50">{fixResult.errors.length} item{fixResult.errors.length > 1 ? "s" : ""} skipped →</summary>
                    <ul className="mt-2 space-y-1 pl-3">
                      {fixResult.errors.map((e, i) => <li key={i} className="text-white/30 text-xs font-mono">{e}</li>)}
                    </ul>
                  </details>
                )}
              </div>

              {/* ── Fix Verification card ── */}
              {fixResult.scannerGate && (
                <div className="mt-5 rounded-xl px-5 py-4"
                  style={{ background: "rgba(45,212,191,0.06)", border: "1px solid rgba(45,212,191,0.2)" }}>
                  {fixResult.scannerGate.skipped ? (
                    /* Gate skipped — syntax-checked only */
                    <div className="flex items-center gap-2">
                      <span className="text-teal-400 text-sm">✓</span>
                      <span className="text-teal-400 text-xs font-semibold">Syntax-checked</span>
                      <span className="text-white/30 text-xs ml-1">
                        {fixResult.scannerGate.reason || "Each fix was validated for syntax before inclusion in the PR."}
                      </span>
                    </div>
                  ) : (
                    /* Full gate ran — show before/after */
                    <>
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-teal-400 text-sm">✓</span>
                        <span className="text-teal-400 text-xs font-semibold tracking-wide uppercase">GateTest verified every fix</span>
                      </div>
                      <div className="grid grid-cols-4 gap-3 text-center">
                        <div className="rounded-lg py-2.5 px-2"
                          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)" }}>
                          <div className="text-xl font-bold text-red-400">{scanResult.totalIssues}</div>
                          <div className="text-white/30 text-[10px] mt-0.5">Before</div>
                        </div>
                        <div className="flex items-center justify-center">
                          <span className="text-white/20 text-lg font-light">→</span>
                        </div>
                        <div className="rounded-lg py-2.5 px-2"
                          style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)" }}>
                          <div className="text-xl font-bold text-emerald-400">
                            {Math.max(0, scanResult.totalIssues - (fixResult.issuesFixed || 0))}
                          </div>
                          <div className="text-white/30 text-[10px] mt-0.5">After fixes</div>
                        </div>
                        <div className="rounded-lg py-2.5 px-2"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                          <div className="text-xl font-bold text-white/60">
                            {fixResult.scannerGate.rolledBack?.length || 0}
                          </div>
                          <div className="text-white/30 text-[10px] mt-0.5">Rolled back</div>
                        </div>
                      </div>
                      <div className="mt-2.5 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
                        <span className="text-white/35 text-[11px]">
                          {fixResult.scannerGate.summary || "Re-scanned ✓ — every fix re-validated by the full scanner before inclusion"}
                        </span>
                      </div>
                      {fixResult.scannerGate.rolledBack && fixResult.scannerGate.rolledBack.length > 0 && (
                        <details className="mt-3">
                          <summary className="text-white/30 text-xs cursor-pointer hover:text-white/50">
                            {fixResult.scannerGate.rolledBack.length} fix{fixResult.scannerGate.rolledBack.length > 1 ? "es" : ""} rolled back — new issues introduced →
                          </summary>
                          <ul className="mt-2 space-y-2 pl-3">
                            {fixResult.scannerGate.rolledBack.map((rb, i) => (
                              <li key={i} className="text-xs">
                                <code className="text-teal-400/70 font-mono">{rb.file}</code>
                                <span className="text-white/30 ml-2">{rb.reason}</span>
                                {rb.newFindings.length > 0 && (
                                  <ul className="mt-1 pl-3 space-y-0.5">
                                    {rb.newFindings.map((f, j) => (
                                      <li key={j} className="text-white/25 font-mono text-[10px]">{f}</li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── AI Fixing in progress ── */}
          {fixing && !fixResult && (
            <div className="mb-10 rounded-2xl p-6 sm:p-8 text-center"
              style={{ background: "rgba(45,212,191,0.05)", border: "1px solid rgba(45,212,191,0.15)" }}>
              <div className="w-12 h-12 rounded-full border-2 border-teal-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <h2 className="text-xl font-bold text-white mb-2">Claude is fixing your code…</h2>
              <p className="text-white/40 text-sm">Reading every file, generating fixes, re-running the scanner on each one. This takes 1–3 minutes.</p>
              <div className="mt-5 mx-auto max-w-xs">
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <div className="h-full rounded-full animate-pulse" style={{ width: "60%", background: "linear-gradient(90deg, #0d9488, #2dd4bf)" }} />
                </div>
              </div>
            </div>
          )}

          {/* ── Fix CTA — if not yet started ── */}
          {hasIssues && !fixing && !fixResult && !fixError && (
            <div className="mb-10 rounded-2xl p-6 sm:p-8"
              style={{ background: "rgba(45,212,191,0.05)", border: "1px solid rgba(45,212,191,0.15)" }}>
              <div className="flex items-start justify-between gap-6">
                <div className="flex-1">
                  <h2 className="text-xl font-bold text-white mb-2">Fix everything automatically</h2>
                  <p className="text-white/40 text-sm mb-5">
                    Claude reads every affected file, generates the smallest correct fix, re-runs the scanner to confirm, then opens a pull request. You review and merge — GateTest never auto-merges.
                  </p>
                  <div className="flex flex-wrap gap-3 text-xs text-white/30 mb-5">
                    {["Reads file context", "Verifies each fix", "Opens a PR", "You control the merge"].map((f) => (
                      <span key={f} className="flex items-center gap-1.5">
                        <span className="text-teal-500">✓</span>{f}
                      </span>
                    ))}
                  </div>
                  <button onClick={runFix}
                    className="inline-flex items-center gap-2 px-7 py-4 rounded-xl font-bold text-sm"
                    style={{ background: "#2dd4bf", color: "#080b14" }}>
                    Fix {scanResult.totalIssues} Issue{scanResult.totalIssues > 1 ? "s" : ""} — Open PR &nbsp;&rarr;
                  </button>
                </div>
                {critCount > 0 && (
                  <div className="shrink-0 hidden sm:flex flex-col items-center gap-1 p-4 rounded-xl text-center"
                    style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                    <span className="text-2xl font-bold text-red-400">{critCount}</span>
                    <span className="text-red-400/70 text-xs">Critical</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Fix error */}
          {fixError && (
            <div className="mb-10 p-4 rounded-xl" style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)" }}>
              <p className="text-yellow-400 text-sm">{fixError}</p>
              <button onClick={runFix} className="mt-3 text-xs text-white/50 hover:text-white/70 underline">Try again</button>
            </div>
          )}

          {/* ── Result headline ── */}
          {!hasIssues ? (
            <div className="text-center mb-10">
              <div className="w-20 h-20 rounded-full mx-auto mb-5 flex items-center justify-center"
                style={{ background: "rgba(16,185,129,0.15)", border: "2px solid rgba(16,185,129,0.4)" }}>
                <span className="text-4xl font-bold text-emerald-400">✓</span>
              </div>
              <h2 className="text-4xl sm:text-5xl font-bold text-white mb-3">GATE: PASSED</h2>
              <p className="text-white/40 text-lg">
                {scanResult.completedModules} modules · {scanResult.totalModules > 0 ? `${scanResult.totalModules * 8}+` : "800+"} checks · all clean
              </p>
            </div>
          ) : (
            <div className="mb-8">
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-1">
                {scanResult.totalIssues} issue{scanResult.totalIssues > 1 ? "s" : ""} found
              </h2>
              <p className="text-white/30 text-sm font-mono">{repoShort}</p>
            </div>
          )}

          {/* ── Severity breakdown ── */}
          {hasIssues && (
            <div className="grid grid-cols-4 gap-2 mb-8">
              {[
                { count: critCount, label: "Critical", color: "text-red-400", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.2)" },
                { count: highCount, label: "High", color: "text-orange-400", bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.2)" },
                { count: medCount, label: "Medium", color: "text-yellow-400", bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.2)" },
                { count: lowCount, label: "Low", color: "text-blue-400", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.2)" },
              ].map((s) => (
                <div key={s.label} className="text-center rounded-xl py-4 px-2"
                  style={{ background: s.bg, border: `1px solid ${s.border}` }}>
                  <div className={`text-2xl sm:text-3xl font-bold ${s.color}`}>{s.count}</div>
                  <div className="text-white/30 text-xs mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Stats row ── */}
          <div className="grid grid-cols-3 gap-3 mb-8">
            {[
              { value: scanResult.completedModules, label: "Modules scanned" },
              { value: `${scanResult.duration ? Math.round(scanResult.duration / 1000) : elapsed}s`, label: "Scan time" },
              { value: fixResult?.filesFixed || scanResult.totalFixed || 0, label: "Files fixed" },
            ].map((s) => (
              <div key={s.label} className="text-center rounded-xl py-4"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="text-xl font-bold text-white">{s.value}</div>
                <div className="text-white/25 text-xs mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* ── Module findings list ── */}
          {hasIssues && failedModules.length > 0 && (
            <div className="mb-8">
              <h3 className="text-white/50 text-xs font-semibold tracking-wider uppercase mb-3">Findings by module</h3>
              <div className="space-y-2">
                {failedModules.map((mod) => {
                  const label = MODULE_LABELS[mod.name] || mod.name;
                  const isOpen = expandedModules.has(mod.name);
                  return (
                    <div key={mod.name} className="rounded-xl overflow-hidden"
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                      <button
                        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
                        onClick={() => setExpandedModules((s) => { const n = new Set(s); if (n.has(mod.name)) { n.delete(mod.name); } else { n.add(mod.name); } return n; })}>
                        <div className="flex items-center gap-3">
                          <span className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold shrink-0"
                            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}>!</span>
                          <span className="font-medium text-white/80 text-sm">{label}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}>
                            {mod.issues || (mod.details?.length || 1)} issue{(mod.issues || (mod.details?.length || 1)) > 1 ? "s" : ""}
                          </span>
                          <span className={`text-white/30 text-xs transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}>▾</span>
                        </div>
                      </button>

                      {isOpen && mod.details && mod.details.length > 0 && (
                        <div className="border-t border-white/[0.05] divide-y divide-white/[0.04]">
                          {mod.details.map((d, i) => {
                            const sev = severityOf(d);
                            const fileMatch = d.match(/^([\w./\-@+]+?\.[\w]{1,8})(?::(\d+))?(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
                            return (
                              <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                                <div className="pt-0.5"><SeverityBadge sev={sev} /></div>
                                <div className="flex-1 min-w-0">
                                  {fileMatch ? (
                                    <>
                                      <code className="text-teal-400/70 text-xs font-mono block truncate">
                                        {fileMatch[1]}{fileMatch[2] ? `:${fileMatch[2]}` : ""}
                                      </code>
                                      <p className="text-white/55 text-xs mt-0.5">{fileMatch[3]}</p>
                                    </>
                                  ) : (
                                    <p className="text-white/55 text-xs font-mono">{d}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Passed modules (collapsed) ── */}
          {scanResult.modules.filter((m) => m.status === "passed").length > 0 && (
            <details className="mb-8 group">
              <summary className="text-white/25 text-xs cursor-pointer hover:text-white/40 select-none list-none flex items-center gap-2">
                <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                {scanResult.modules.filter((m) => m.status === "passed").length} modules passed
              </summary>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                {scanResult.modules.filter((m) => m.status === "passed").map((mod) => (
                  <div key={mod.name} className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                    style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.12)" }}>
                    <span className="text-emerald-500">✓</span>
                    <span className="text-white/40">{MODULE_LABELS[mod.name] || mod.name}</span>
                    {mod.duration > 0 && <span className="ml-auto text-white/20 font-mono">{mod.duration}ms</span>}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* ── Upgrade CTA for quick tier ── */}
          {params.tier === "quick" && hasIssues && !fixing && (
            <div className="mb-6 p-4 rounded-xl flex items-center justify-between gap-4"
              style={{ background: "rgba(45,212,191,0.05)", border: "1px solid rgba(45,212,191,0.12)" }}>
              <p className="text-white/40 text-sm">
                Running 4 of 90 modules. <strong className="text-white/60">Full Scan</strong> covers security, supply chain, auth, AI review, and 86 more.
              </p>
              <Link href="/#pricing" className="shrink-0 px-4 py-2 rounded-lg text-xs font-semibold text-teal-400 whitespace-nowrap"
                style={{ background: "rgba(45,212,191,0.1)", border: "1px solid rgba(45,212,191,0.2)" }}>
                Full Scan — $99
              </Link>
            </div>
          )}

          {/* ── Scan another / dashboard ── */}
          <div className="flex flex-col sm:flex-row gap-3 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <Link href="/#pricing" className="flex-1 text-center px-5 py-3 rounded-xl text-sm font-medium text-white/50 hover:text-white/70 transition-colors"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
              Scan another repo
            </Link>
            <Link href="/dashboard" className="flex-1 text-center px-5 py-3 rounded-xl text-sm font-medium text-white/50 hover:text-white/70 transition-colors"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
              My scans
            </Link>
          </div>

          <p className="text-center text-white/15 text-xs mt-6">GateTest · gatetest.ai</p>
        </div>
      </div>
    );
  }

  // ── EXPIRED ───────────────────────────────────────────────────────────────
  if (isExpired) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "#080b14" }}>
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center"
            style={{ background: "rgba(100,116,139,0.15)", border: "1px solid rgba(100,116,139,0.3)" }}>
            <span className="text-slate-400 text-2xl">⏱</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Session Expired</h2>
          <p className="text-white/40 text-sm mb-6">{scanResult?.error || "This checkout session expired before the scan ran. No charge was made."}</p>
          <Link href="/#pricing" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm"
            style={{ background: "#2dd4bf", color: "#080b14" }}>
            Start New Scan
          </Link>
        </div>
      </div>
    );
  }

  // ── FAILED ────────────────────────────────────────────────────────────────
  if (isFailed) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "#080b14" }}>
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center"
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}>
            <span className="text-red-400 text-2xl">✗</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Scan Failed</h2>
          <p className="text-white/40 text-sm mb-1">{scanResult?.error || "Something went wrong."}</p>
          <p className="text-white/25 text-xs mb-6">No charge was made. Card hold released.</p>
          <Link href="/#pricing" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm"
            style={{ background: "#2dd4bf", color: "#080b14" }}>
            Try Again
          </Link>
        </div>
      </div>
    );
  }

  // Fallback loading (params not yet ready)
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#080b14" }}>
      <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
