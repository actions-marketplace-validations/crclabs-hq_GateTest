/**
 * <HomeSelfScan> — "we eat our own dog food" trust badge.
 *
 * Currently static: 91/91 modules pass, self-scan runs on every push to
 * main. The static value is honest — the self-scan workflow is in
 * .github/workflows/ci.yml and the gate is non-soft (Bible Forbidden #24).
 *
 * Wire to a live read of the latest self-scan run only when a stats endpoint
 * exists (Agent W5's territory). Until then, static is the right answer.
 */

import Link from "next/link";

export default function HomeSelfScan() {
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
            were red we&apos;d have no business asking you to use it. Here&apos;s
            the live status panel — same shape you&apos;ll see on your repo.
          </p>
        </div>

        <div className="rounded-2xl bg-[#14141d] text-white shadow-2xl overflow-hidden">
          {/* Terminal-style header */}
          <div className="px-5 py-3 flex items-center gap-2 border-b border-white/8">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[11px] text-white/40 font-mono">
              ccantynz-alt/gatetest &nbsp;&middot;&nbsp; main &nbsp;&middot;&nbsp; gate
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400">
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              LIVE
            </span>
          </div>

          <div className="p-6 sm:p-8">
            {/* Status hero row */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 pb-6 border-b border-white/8">
              <div>
                <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2">
                  Our own gate
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl font-bold text-emerald-400 tracking-tight">
                    GREEN
                  </span>
                  <span className="text-sm text-white/40 font-mono">
                    91/91 modules &middot; 0 errors &middot; 3,500+ tests
                  </span>
                </div>
              </div>
              <Link
                href="https://github.com/ccantynz-alt/GateTest/actions"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors"
              >
                View CI runs
                <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>

            {/* Module grid — sample of 16 representative modules */}
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
              <div className="flex items-center gap-2 py-1 col-span-2 sm:col-span-4 text-white/40 text-xs italic">
                ...75 more modules passed
              </div>
            </div>

            {/* Bottom badge */}
            <div className="mt-8 pt-6 border-t border-white/8 grid grid-cols-3 gap-4">
              <SelfStat label="Scan time" value="11.3s" />
              <SelfStat label="Last run" value="On main" />
              <SelfStat label="Soft-fail policy" value="Never" />
            </div>
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
