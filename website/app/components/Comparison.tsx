const rows: { label: string; gatetest: string; sonar: boolean; snyk: boolean; copilot: boolean; semgrep: boolean }[] = [
  { label: "SSRF / URL injection", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Cross-finding attack chains", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Money float precision (parseFloat)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "PII flow to logs (GDPR)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Circular imports (TDZ)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "N+1 query in ORM loops", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Async-iteration footguns", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Race conditions (TOCTOU)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "ReDoS catastrophic backtracking", gatetest: "error", sonar: true, snyk: false, copilot: false, semgrep: false },
  { label: "Supply chain / CVEs", gatetest: "error", sonar: false, snyk: true, copilot: false, semgrep: false },
  { label: "Secret rotation (90d age)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "TLS cert bypass", gatetest: "error", sonar: true, snyk: false, copilot: false, semgrep: true },
  { label: "Stale feature flags", gatetest: "warning", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Mutation testing (tests test tests)", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Auto-fix PR with Claude", gatetest: "unique", sonar: false, snyk: false, copilot: true, semgrep: false },
  { label: "Iterative fix loop (retry on fail)", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Fake-fix detector", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Pay only when PR delivered", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
];

const Icon = ({ yes }: { yes: boolean }) =>
  yes ? (
    <span className="text-emerald-400 text-sm font-bold">✓</span>
  ) : (
    <span className="text-white/15 text-xs">—</span>
  );

const severityBadge = (s: string) => {
  if (s === "error") return <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-mono">error</span>;
  if (s === "warning") return <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono">warning</span>;
  return <span className="text-xs px-2 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 font-mono">only us</span>;
};

export default function Comparison() {
  return (
    <section id="comparison" className="py-24 px-6 border-t border-white/8">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14">
          <span className="inline-block px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/50 text-xs font-semibold uppercase tracking-widest mb-4">
            Competitive Reality
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
            They flag the easy stuff.
            <br />
            <span className="hero-accent-text">We find the bugs that actually hurt.</span>
          </h2>
          <p className="text-white/50 text-lg max-w-2xl mx-auto">
            GateTest finds entire categories of bugs no competitor on the market today detects.
            Not incremental improvement — a different product category.
          </p>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-white/10 overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] bg-white/[0.03] border-b border-white/10">
            <div className="px-4 py-3 text-xs text-white/40 font-semibold uppercase tracking-wider">Check</div>
            <div className="px-3 py-3 text-xs text-emerald-400 font-bold text-center">GateTest</div>
            <div className="px-3 py-3 text-xs text-white/35 font-semibold text-center">SonarQube</div>
            <div className="px-3 py-3 text-xs text-white/35 font-semibold text-center">Snyk</div>
            <div className="px-3 py-3 text-xs text-white/35 font-semibold text-center">Copilot</div>
            <div className="px-3 py-3 text-xs text-white/35 font-semibold text-center">Semgrep</div>
          </div>

          {/* Rows */}
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={`grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] border-b border-white/5 hover:bg-white/[0.02] transition-colors ${
                i % 2 === 0 ? "bg-transparent" : "bg-white/[0.01]"
              }`}
            >
              <div className="px-4 py-3 text-sm text-white/70 flex items-center gap-2">
                {row.label}
                {row.gatetest === "unique" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">only us</span>
                )}
              </div>
              <div className="px-3 py-3 flex items-center justify-center">{severityBadge(row.gatetest)}</div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.sonar} /></div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.snyk} /></div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.copilot} /></div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.semgrep} /></div>
            </div>
          ))}
        </div>

        <p className="text-center text-white/25 text-xs mt-4">
          Based on published documentation. Last verified May 2026. GateTest covers 90 modules total — this table shows 18.
        </p>

        {/* Bottom stats */}
        <div className="grid grid-cols-3 gap-4 mt-10">
          {[
            { value: "12", label: "Bug categories only GateTest finds", sub: "No competitor has equivalents" },
            { value: "90", label: "Scan modules", sub: "SonarQube: ~10. Snyk: ~4. Copilot: ~3." },
            { value: "0", label: "Dollars if we fail", sub: "Every competitor charges whether bugs are found or not" },
          ].map((s) => (
            <div key={s.label} className="text-center p-6 rounded-xl bg-white/5 border border-white/8">
              <div className="text-4xl font-bold text-white mb-1">{s.value}</div>
              <div className="text-sm text-white/60 font-medium">{s.label}</div>
              <div className="text-xs text-white/30 mt-1">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
