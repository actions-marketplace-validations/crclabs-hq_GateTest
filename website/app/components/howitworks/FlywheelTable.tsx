/**
 * The four flywheel layers, side-by-side. Each layer is a column on
 * desktop, stacks on mobile. Matches the orchestrator in
 * website/app/lib/try-fix.js — AST → Rule → Recipe → Claude.
 */

type Layer = {
  number: string;
  name: string;
  cost: string;
  description: string;
  wins: string;
  example: { before: string; after: string };
  accent: string;
  border: string;
  bg: string;
};

const LAYERS: Layer[] = [
  {
    number: "1",
    name: "AST",
    cost: "$0.00",
    description: "Babel-parsed deterministic transforms — currently ~10 canonical patterns covering TLS, cookies, parseInt radix, async-iteration, and the most common config flips.",
    wins: "When the bug is a single config flag or call-site argument that can be flipped without semantic ambiguity.",
    example: {
      before: "https.Agent({\n  rejectUnauthorized: false\n})",
      after:  "https.Agent({\n  rejectUnauthorized: true\n})",
    },
    accent: "text-teal-300",
    border: "border-teal-500/30",
    bg: "bg-teal-500/[0.04]",
  },
  {
    number: "2",
    name: "Rule",
    cost: "$0.00",
    description: "Regex and structural pattern engine for shapes the AST doesn't model. Same-file edits, deterministic replacements, fast path for high-frequency patterns.",
    wins: "When the bug is a recognisable line-level shape that AST traversal would have to special-case.",
    example: {
      before: "console.log(user)",
      after:  "logger.info({ user_id: user.id })",
    },
    accent: "text-indigo-300",
    border: "border-indigo-500/30",
    bg: "bg-indigo-500/[0.04]",
  },
  {
    number: "3",
    name: "Recipe",
    cost: "$0.00",
    description: "Cached fixes that Claude solved on a previous scan. The 'auto-distill' step records the before/after when Claude's diff is small and templatey — next time the same shape appears, the recipe wins.",
    wins: "Anything Claude has solved before. The recipe layer is the flywheel — it learns from every paid fix.",
    example: {
      before: "// match by ruleKey + file ext\n// hit: js-reject-unauthorized\n// applied 7 times",
      after:  "// recipe applied, zero cost\n// promoted to 'stable' at 3 hits",
    },
    accent: "text-amber-300",
    border: "border-amber-500/30",
    bg: "bg-amber-500/[0.04]",
  },
  {
    number: "4",
    name: "Claude",
    cost: "paid",
    description: "Anthropic Claude Sonnet. Only invoked when the first three layers all return null. Bounded by a 30s per-layer timeout, capped per tier so spend never exceeds margin.",
    wins: "First-time-seen patterns. Bespoke business-logic bugs. Anything templated layers can't model.",
    example: {
      before: "// novel pattern: ad-hoc auth check\n// mixed with feature-flag rollout\n// no canonical shape",
      after:  "// Claude reasons from your code\n// fix lands, auto-distill records\n// next time → recipe layer",
    },
    accent: "text-pink-300",
    border: "border-pink-500/30",
    bg: "bg-pink-500/[0.04]",
  },
];

export default function FlywheelTable() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {LAYERS.map((layer) => (
        <div
          key={layer.number}
          className={`rounded-xl border ${layer.border} ${layer.bg} p-5 flex flex-col`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-white/40">{layer.number}</span>
              <span className={`font-mono font-bold text-base ${layer.accent}`}>{layer.name}</span>
            </div>
            <span className="text-xs font-mono text-white/50 px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.03]">
              {layer.cost}
            </span>
          </div>

          <p className="text-sm text-white/60 leading-relaxed mb-4">{layer.description}</p>

          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mb-1.5">
              When it wins
            </div>
            <p className="text-sm text-white/65 leading-relaxed">{layer.wins}</p>
          </div>

          <div className="mt-auto pt-3 border-t border-white/[0.06]">
            <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mb-1.5">
              Example
            </div>
            <pre className="text-[11px] text-red-300/80 font-mono whitespace-pre-wrap leading-snug bg-black/30 rounded-md p-2 mb-1.5 border border-red-500/15">
{layer.example.before}
            </pre>
            <pre className="text-[11px] text-emerald-300/80 font-mono whitespace-pre-wrap leading-snug bg-black/30 rounded-md p-2 border border-emerald-500/15">
{layer.example.after}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}
