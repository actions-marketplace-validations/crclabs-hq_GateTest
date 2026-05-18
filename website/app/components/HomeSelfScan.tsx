/**
 * <HomeSelfScan> — "we eat our own dog food" trust badge.
 *
 * Reads live data from the in-memory self-scan store via the shared lib
 * (see website/app/lib/self-scan-status.js, populated by CI publishes to
 * /api/internal/self-scan-status). Falls back to a static "Awaiting first
 * scan" state when no data has been received yet — honest, not faked.
 */

import Link from "next/link";

// CommonJS interop — shared with the route handler + the unit tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selfScanStatus = require("@/app/lib/self-scan-status") as {
  getLatestStatus(nowMs?: number): unknown;
  deriveBadgeState(data: unknown, fetchError?: unknown): {
    variant: "passed" | "blocked" | "awaiting";
    labelText: string;
    metricLine: string | null;
    commitShaShort: string | null;
    ariaLabel: string;
  };
};

interface LatestStatus {
  status?: string;
  gateStatus?: "PASSED" | "BLOCKED";
  modulesPassedCount?: number;
  modulesTotalCount?: number;
  errorCount?: number;
  warningCount?: number;
  ageMinutes?: number;
  commitSha?: string;
  scannedAt?: string;
  durationMs?: number;
}

export default function HomeSelfScan() {
  const data = selfScanStatus.getLatestStatus() as LatestStatus | null;
  const badge = selfScanStatus.deriveBadgeState(data);

  const isLive = badge.variant !== "awaiting";
  const statusColor =
    badge.variant === "passed"
      ? "text-emerald-400"
      : badge.variant === "blocked"
      ? "text-rose-400"
      : "text-slate-400";
  const dotColor =
    badge.variant === "passed"
      ? "bg-emerald-400"
      : badge.variant === "blocked"
      ? "bg-rose-400"
      : "bg-slate-400";

  const passedCount = data?.modulesPassedCount;
  const totalCount = data?.modulesTotalCount;
  const errorCount = data?.errorCount;
  const warningCount = data?.warningCount;
  const durationSec =
    typeof data?.durationMs === "number" ? (data.durationMs / 1000).toFixed(1) : null;
  const ageMinutes = typeof data?.ageMinutes === "number" ? data.ageMinutes : null;

  return (
    <section id="self-scan" className="py-20 px-6 border-t border-border">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-10">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            Don&apos;t trust us
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-3 text-foreground">
            Trust the green.
          </h2>
          <p className="text-muted text-base max-w-2xl mx-auto">
            GateTest runs against itself on every push to main. If our own gate
            were red we&apos;d have no business asking you to use it. Below is
            the live status panel — same shape you&apos;ll see on your repo.
          </p>
        </div>

        <div
          className="rounded-2xl bg-[#14141d] text-white shadow-2xl overflow-hidden"
          role="status"
          aria-live="polite"
          aria-label={badge.ariaLabel}
        >
          {/* Terminal-style header */}
          <div className="px-5 py-3 flex items-center gap-2 border-b border-white/8">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[11px] text-white/40 font-mono">
              crclabs-hq/gatetest &nbsp;&middot;&nbsp; main &nbsp;&middot;&nbsp; gate
              {badge.commitShaShort && (
                <>
                  &nbsp;&middot;&nbsp;
                  <span className="text-white/60">{badge.commitShaShort}</span>
                </>
              )}
            </span>
            <span
              className={`ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold ${
                isLive ? "text-emerald-400" : "text-slate-400"
              }`}
            >
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                {isLive && (
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full ${dotColor} opacity-75`}
                  />
                )}
                <span
                  className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotColor}`}
                />
              </span>
              {isLive ? "LIVE" : "STANDBY"}
            </span>
          </div>

          <div className="p-6 sm:p-8">
            {/* Status hero row */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 pb-6 border-b border-white/8">
              <div>
                <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2">
                  Our own gate
                </div>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className={`text-4xl font-bold ${statusColor} tracking-tight`}>
                    {badge.labelText}
                  </span>
                  <span className="text-sm text-white/40 font-mono">
                    {badge.metricLine
                      ? badge.metricLine
                      : "self-scan workflow runs on every push to main"}
                  </span>
                </div>
              </div>
              <Link
                href="https://github.com/crclabs-hq/GateTest/actions"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors"
              >
                View CI runs
                <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>

            {/* Module sample grid — representative of what the gate runs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm font-mono">
              {[
                "syntax",
                "lint",
                "secrets",
                "codeQuality",
                "security",
                "ssrf",
                "tlsSecurity",
                "cookieSecurity",
                "accessibility",
                "performance",
                "ciSecurity",
                "dockerfile",
                "kubernetes",
                "dependencies",
                "redos",
                "money-float",
              ].map((mod) => (
                <div
                  key={mod}
                  className="flex items-center gap-2 py-1 text-white/70"
                >
                  <span className="text-emerald-400" aria-hidden="true">&#10003;</span>
                  <span className="text-white/85">{mod}</span>
                </div>
              ))}
              {typeof totalCount === "number" && totalCount > 16 && (
                <div className="flex items-center gap-2 py-1 col-span-2 sm:col-span-4 text-white/40 text-xs italic">
                  ...{totalCount - 16} more modules in this scan
                </div>
              )}
            </div>

            {/* Bottom stats — live values when available, static labels otherwise */}
            <div className="mt-8 pt-6 border-t border-white/8 grid grid-cols-3 gap-4">
              <SelfStat
                label="Scan time"
                value={durationSec ? `${durationSec}s` : "—"}
              />
              <SelfStat
                label="Last run"
                value={ageMinutes !== null ? formatAge(ageMinutes) : "Awaiting"}
              />
              <SelfStat label="Soft-fail policy" value="Never" />
            </div>

            {/* Stats footer — only renders when we actually have data */}
            {isLive && typeof errorCount === "number" && (
              <div className="mt-4 text-xs text-white/40 font-mono">
                Errors: {errorCount} &middot; Warnings: {warningCount ?? 0} &middot;
                Modules passed: {passedCount}/{totalCount}
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-muted text-center mt-6">
          The self-scan workflow lives in{" "}
          <code className="font-mono text-accent">.github/workflows/ci.yml</code>.
          Bible Forbidden #24 means{" "}
          <code className="font-mono">continue-on-error: true</code> is banned
          on the gate step — so a red gate would block the commit, not just
          warn.
        </p>
      </div>
    </section>
  );
}

function SelfStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
        {label}
      </div>
      <div className="text-sm font-bold text-white/90 tabular-nums mt-1 font-mono">
        {value}
      </div>
    </div>
  );
}

function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}
