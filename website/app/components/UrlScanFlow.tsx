"use client";

/**
 * <UrlScanFlow> — paste-URL → scan → results, shared by /web and /wp.
 *
 * Sub-components live in sibling files to keep this orchestrator under the
 * file-length budget:
 *   - url-scan-flow-types.ts     — shared types + constants
 *   - url-scan-flow-cards.tsx    — HealthScore, Stat, Finding, Recommendation, Paywall
 *   - url-scan-flow-progress.tsx — LiveModule, Progress, RuntimePending tickers
 *   - url-scan-flow-export.tsx   — Copy-for-Claude prompt formatter + button
 *   - url-scan-flow-sse.ts       — text/event-stream parser
 *
 * Design rules:
 *   - Bible: "the scan experience must be CINEMATIC." Module-by-module
 *     ticker, animated score reveal, staggered finding cards.
 *   - Findings are CLUSTERS (1 missing CSP header = 1 row).
 *   - Runtime status: hide entirely when "unavailable".
 *   - Paywall CTA appears below findings when preview === true.
 *
 * Accessibility: all interactive elements keyboard-focusable, aria-live
 * region for state changes, findings expand via <details>/<summary>.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  Finding,
  ModuleProgress,
  Recommendation,
  RuntimeBlock,
  ScanResult,
  UrlScanFlowProps,
} from "./url-scan-flow-types";
import { HealthScoreCard, StatCard, FindingRow, RecommendationCard, PaywallCard } from "./url-scan-flow-cards";
import { LiveModuleTicker, ProgressTicker, RuntimePending } from "./url-scan-flow-progress";
import { CopyForClaudeButton } from "./url-scan-flow-export";
import { consumeSseStream } from "./url-scan-flow-sse";

export function UrlScanFlow({ suite, endpoint, streamEndpoint, recommendEndpoint, placeholderUrl = "https://yoursite.com", brandLabel, initialUrl = "" }: UrlScanFlowProps) {
  type Phase = "idle" | "scanning" | "results" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState(initialUrl);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [liveModules, setLiveModules] = useState<ModuleProgress[]>([]);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const tickerRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recAbortRef = useRef<AbortController | null>(null);

  // Debounced pre-scan recommendation fetch. Fires when URL looks valid
  // and hasn't changed for 600ms. Aborts any in-flight previous fetch.
  // Failures are silent — the card just doesn't appear.
  useEffect(() => {
    if (!recommendEndpoint || phase !== "idle") return;
    const trimmed = url.trim();
    if (!trimmed) { setRecommendation(null); return; }
    if (!/^https?:\/\/[^/\s.]+\.[^/\s]+/i.test(trimmed) && !/^[^/\s.]+\.[^/\s.]+/.test(trimmed)) {
      setRecommendation(null);
      return;
    }
    const timer = setTimeout(async () => {
      if (recAbortRef.current) recAbortRef.current.abort();
      const abort = new AbortController();
      recAbortRef.current = abort;
      try {
        const res = await fetch(recommendEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
          signal: abort.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.recommendation) {
          setRecommendation(data as Recommendation);
        }
      } catch {
        /* abort or network error — silent */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [url, recommendEndpoint, phase]);

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

  async function runStreaming(targetUrl: string, abort: AbortController) {
    if (!streamEndpoint) throw new Error("no-stream-endpoint");
    const res = await fetch(streamEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ url: targetUrl }),
      signal: abort.signal,
    });
    if (!res.ok) {
      let errMsg = `Scan failed (HTTP ${res.status})`;
      try {
        const j = await res.json();
        errMsg = j?.error || errMsg;
      } catch { /* ignore */ }
      throw new Error(errMsg);
    }

    let completed: ScanResult | null = null;
    await consumeSseStream(res, (event, data) => {
      if (event === "module:start") {
        const d = data as { module: string };
        setLiveModules((prev) => {
          const i = prev.findIndex((m) => m.name === d.module);
          if (i >= 0) {
            const copy = [...prev];
            copy[i] = { ...copy[i], state: "running" };
            return copy;
          }
          return [...prev, { name: d.module, state: "running" }];
        });
      } else if (event === "module:end") {
        const d = data as { module: string; errors?: number; warnings?: number; duration?: number };
        setLiveModules((prev) => {
          const i = prev.findIndex((m) => m.name === d.module);
          const updated: ModuleProgress = { name: d.module, state: "done", errors: d.errors, warnings: d.warnings, duration: d.duration };
          if (i >= 0) {
            const copy = [...prev];
            copy[i] = updated;
            return copy;
          }
          return [...prev, updated];
        });
      } else if (event === "module:skip") {
        const d = data as { module: string };
        setLiveModules((prev) => {
          const i = prev.findIndex((m) => m.name === d.module);
          const updated: ModuleProgress = { name: d.module, state: "skipped" };
          if (i >= 0) {
            const copy = [...prev];
            copy[i] = updated;
            return copy;
          }
          return [...prev, updated];
        });
      } else if (event === "complete") {
        completed = data as ScanResult;
      } else if (event === "error") {
        const d = data as { error?: string };
        throw new Error(d?.error || "Scan errored mid-stream");
      }
    }, abort.signal);

    if (!completed) throw new Error("Scan stream closed without a complete event");
    return completed;
  }

  async function runNonStreaming(targetUrl: string): Promise<ScanResult> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Scan failed. Please try a different URL.");
    return data as ScanResult;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!url.trim()) return;
    const targetUrl = url.trim();
    setError(null);
    setLiveModules([]);
    setPhase("scanning");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const data = streamEndpoint
        ? await runStreaming(targetUrl, abort)
        : await runNonStreaming(targetUrl);
      setResult(data);
      setPhase("results");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setPhase("idle");
        return;
      }
      setError(err instanceof Error ? err.message : "Network error — please try again.");
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }

  function reset() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setResult(null);
    setError(null);
    setLiveModules([]);
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
      <form
        onSubmit={handleSubmit}
        className="flex flex-col sm:flex-row items-stretch justify-center gap-3 max-w-xl mx-auto"
      >
        <label className="sr-only" htmlFor="url-scan-input">Website URL to scan</label>
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
        <>
          <p className="text-center text-sm text-muted mt-6">
            Free preview — top 3 issues plus your Health Score. No signup, no install.
          </p>
          {recommendation && <RecommendationCard rec={recommendation} />}
        </>
      )}

      {phase === "scanning" && (
        <div className="mt-10 max-w-2xl mx-auto">
          {streamEndpoint && liveModules.length > 0 ? (
            <LiveModuleTicker modules={liveModules} elapsedSec={elapsedSec} />
          ) : (
            <ProgressTicker suite={suite} elapsedSec={elapsedSec} />
          )}
        </div>
      )}

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

      {phase === "results" && result && (
        <div className="mt-12 max-w-4xl mx-auto space-y-8">
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

          <HealthScoreCard {...result.healthScore} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Errors" value={result.errorCount} accent="rose" />
            <StatCard label="Warnings" value={result.warningCount} accent="amber" />
            <StatCard label="Root causes" value={result.totalClusters} accent="teal" />
            <StatCard label="Raw findings" value={result.totalFindings} accent="slate" />
          </div>

          {showRuntime && result.runtime?.status === "queued" && result.runtime.pollUrl && (
            <RuntimePending pollUrl={result.runtime.pollUrl} onComplete={applyRuntimePayload} />
          )}

          {result.findings.length > 0 ? (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-xl font-bold">
                    {result.preview ? "Top issues — free preview" : "Every issue found"}
                  </h2>
                  <p className="text-sm text-muted mt-1">
                    Click any row for plain-language detail and fix guidance.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {result.findings.map((f, i) => (
                  <FindingRow key={`${f.ruleKey}-${i}`} finding={f} index={i} />
                ))}
              </div>

              <div className="mt-6">
                <CopyForClaudeButton result={result} />
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

          {result.paywall && result.paywall.remainingCount > 0 && (
            <PaywallCard paywall={result.paywall} targetUrl={result.targetUrl} />
          )}

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
