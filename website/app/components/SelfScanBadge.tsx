"use client";

/**
 * Live self-scan badge — the killer trust signal for the homepage.
 *
 * Renders a small panel that reflects the LATEST state of our own
 * self-scan on `main`. Reads `/api/internal/self-scan-status`:
 *   - `gateStatus === "PASSED"`           → green dot + "GREEN"
 *   - `gateStatus === "BLOCKED"`          → red   dot + "BLOCKED"
 *   - `status === "no-data"` / fetch fail → gray  dot + "Awaiting first scan"
 *
 * First paint:
 *   - If `initialData` is passed by a server component, that renders
 *     immediately with zero network round-trip.
 *   - Otherwise the client fetches once on mount.
 *
 * Refresh:
 *   - Polls every 60s via `useEffect` so a customer who lingers on
 *     the page sees the badge re-flicker after every CI run.
 *
 * Accessibility:
 *   - `role="status"` + `aria-live="polite"` so screen-readers
 *     announce state changes politely (no interruption).
 *
 * NOTE: this component is exported but NOT wired into `page.tsx` —
 * Agent W1 owns the homepage rebuild and will import it.
 */

import { useEffect, useState } from "react";

// CommonJS interop — shared with the route handler + the unit tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selfScanStatus = require("@/app/lib/self-scan-status") as {
  deriveBadgeState(
    data: unknown,
    fetchError: boolean,
  ): {
    variant: "passed" | "blocked" | "awaiting";
    labelText: string;
    metricLine: string | null;
    commitShaShort: string | null;
    ariaLabel: string;
  };
};

export type SelfScanStatusData =
  | {
      gateStatus: "PASSED" | "BLOCKED";
      errorCount: number;
      warningCount: number;
      modulesPassedCount: number;
      modulesTotalCount: number;
      scannedAt: string;
      commitSha: string;
      ageMinutes: number;
    }
  | {
      status: "no-data";
      message: string;
    };

interface SelfScanBadgeProps {
  /** Server-fetched initial data so first paint has no network call. */
  initialData?: SelfScanStatusData | null;
  /** Override poll interval (ms). Default 60_000. Set 0 to disable. */
  pollIntervalMs?: number;
  /** Public link target for the workflow runs. */
  workflowUrl?: string;
}

const DEFAULT_WORKFLOW_URL =
  "https://github.com/crclabs-hq/gatetest/actions";
const DEFAULT_POLL_MS = 60_000;

export default function SelfScanBadge({
  initialData = null,
  pollIntervalMs = DEFAULT_POLL_MS,
  workflowUrl = DEFAULT_WORKFLOW_URL,
}: SelfScanBadgeProps) {
  const [data, setData] = useState<SelfScanStatusData | null>(initialData);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchStatus() {
      try {
        const res = await fetch("/api/internal/self-scan-status", {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setFetchError(true);
          return;
        }
        const json = (await res.json()) as SelfScanStatusData;
        if (!cancelled) {
          setData(json);
          setFetchError(false);
        }
      } catch {
        // network-down / serverless cold start that returned non-JSON —
        // treat as transient, don't blow up the UI. error-ok
        if (!cancelled) setFetchError(true);
      }
    }
    // Always fetch on mount — even when initialData is supplied, the
    // server-rendered snapshot may already be a few seconds stale.
    fetchStatus();
    if (pollIntervalMs > 0) {
      const id = setInterval(fetchStatus, pollIntervalMs);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [pollIntervalMs]);

  // Pure derivation lives in the shared helper so it's unit-tested.
  const state = selfScanStatus.deriveBadgeState(data, fetchError);

  const dotColor =
    state.variant === "passed"
      ? "bg-emerald-400"
      : state.variant === "blocked"
        ? "bg-red-400"
        : "bg-slate-500";
  const labelColor =
    state.variant === "passed"
      ? "text-emerald-300"
      : state.variant === "blocked"
        ? "text-red-300"
        : "text-slate-300";

  const awaitingMessage =
    data && typeof data === "object" && "message" in data && data.message
      ? data.message
      : "Awaiting first self-scan on the main branch";

  return (
    <a
      href={workflowUrl}
      target="_blank"
      rel="noopener noreferrer"
      role="status"
      aria-live="polite"
      aria-label={state.ariaLabel}
      className="group inline-flex flex-col gap-1 rounded-lg border border-slate-700/60 bg-slate-900/70 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-900/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      data-testid="self-scan-badge"
      data-variant={state.variant}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${dotColor} ${
            state.variant === "passed" ? "animate-pulse" : ""
          }`}
          aria-hidden="true"
        />
        <span className="text-xs uppercase tracking-wider text-slate-400">
          Our own gate
        </span>
        <span className={`text-xs font-semibold ${labelColor}`}>
          {state.labelText}
        </span>
      </div>
      {state.metricLine && (
        <div className="text-xs text-slate-400">
          {state.metricLine}
          {state.commitShaShort && (
            <>
              {" · "}
              <span className="font-mono text-slate-500">
                {state.commitShaShort}
              </span>
            </>
          )}
        </div>
      )}
      {state.variant === "awaiting" && (
        <div className="text-xs text-slate-500">{awaitingMessage}</div>
      )}
    </a>
  );
}
