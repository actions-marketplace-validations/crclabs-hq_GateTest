/**
 * The four-tier comparison table — Quick / Full / Scan+Fix / Nuclear.
 * Be honest about what's in and what's NOT. Engineers respect honesty.
 */

type Row = {
  feature: string;
  quick: boolean | string;
  full: boolean | string;
  scanFix: boolean | string;
  nuclear: boolean | string;
};

const ROWS: Row[] = [
  { feature: "Price",                                       quick: "$29",   full: "$99",  scanFix: "$199", nuclear: "$399" },
  { feature: "Modules run",                                 quick: "4",     full: "All",  scanFix: "All",  nuclear: "All"  },
  { feature: "Findings clustering by root cause",           quick: true,    full: true,   scanFix: true,   nuclear: true   },
  { feature: "Health score / verdict",                      quick: true,    full: true,   scanFix: true,   nuclear: true   },
  { feature: "Detailed report (file, line, advisory)",      quick: true,    full: true,   scanFix: true,   nuclear: true   },
  { feature: "AI code review (Claude reads your code)",     quick: false,   full: true,   scanFix: true,   nuclear: true   },
  { feature: "Auto-PR with working fixes",                  quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Iterative fix loop with retry",               quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Cross-fix syntax + scanner gate",             quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Regression test generated per fix",           quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Pair-review (second Claude critiques fixes)", quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Architecture annotations",                    quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Per-finding Claude diagnosis",                quick: false,   full: false,  scanFix: false,  nuclear: true   },
  { feature: "Cross-finding attack-chain correlation",      quick: false,   full: false,  scanFix: false,  nuclear: true   },
  { feature: "Mutation testing",                            quick: false,   full: false,  scanFix: false,  nuclear: true   },
  { feature: "Chaos / fuzz pass",                           quick: false,   full: false,  scanFix: false,  nuclear: true   },
  { feature: "CTO-readable executive summary",              quick: false,   full: false,  scanFix: false,  nuclear: true   },
];

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "string") {
    return <span className="font-mono text-white/85">{value}</span>;
  }
  if (value) {
    return <span className="text-emerald-400 font-bold text-base" aria-label="yes">&#10003;</span>;
  }
  return <span className="text-white/25" aria-label="no">no</span>;
}

export default function TierTable() {
  return (
    <div className="rounded-xl border border-white/[0.08] overflow-x-auto">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="border-b border-white/[0.08] bg-white/[0.02]">
            <th className="text-left px-5 py-4 text-white/50 font-medium">What you get</th>
            <th className="text-center px-4 py-4 text-white/80 font-semibold">Quick</th>
            <th className="text-center px-4 py-4 text-white/80 font-semibold">Full</th>
            <th className="text-center px-4 py-4 text-teal-400 font-semibold">Scan + Fix</th>
            <th className="text-center px-4 py-4 text-pink-300 font-semibold">Nuclear</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr
              key={row.feature}
              className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02] transition-colors"
            >
              <td className="px-5 py-3 text-white/70">{row.feature}</td>
              <td className="px-4 py-3 text-center"><Cell value={row.quick} /></td>
              <td className="px-4 py-3 text-center"><Cell value={row.full} /></td>
              <td className="px-4 py-3 text-center"><Cell value={row.scanFix} /></td>
              <td className="px-4 py-3 text-center"><Cell value={row.nuclear} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
