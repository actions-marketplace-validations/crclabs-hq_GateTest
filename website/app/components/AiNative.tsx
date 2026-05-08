const categories = [
  {
    title: "What AI code tools get wrong",
    color: "red",
    items: [
      "Hallucinated imports that don't exist",
      "Hardcoded API keys in example code",
      "console.log left behind in production",
      "Happy path only — no error handling",
      "Missing ARIA labels and alt text",
      "setInterval without clearInterval",
      "Float arithmetic on currency values",
      "rejectUnauthorized: false for TLS",
    ],
  },
  {
    title: "What human reviewers miss",
    color: "amber",
    items: [
      "Cross-finding attack chains (A+B = CRITICAL)",
      "PII flowing to Datadog / Grafana",
      "SSRF via user-controlled URLs",
      "N+1 queries inside .map() loops",
      "Circular imports causing TDZ errors",
      "Async .filter() returning Promise truthy",
      "Race conditions in check-then-act",
      "Cron expressions with impossible dates",
    ],
  },
  {
    title: "What GateTest catches automatically",
    color: "emerald",
    items: [
      "All 90 modules, every push",
      "Claude Opus 4.7 adaptive reasoning",
      "Attack chain correlation across findings",
      "Iterative fix loop: tries, validates, retries",
      "Fake-fix detector rejects symptom patches",
      "Mutation testing: tests that your tests work",
      "Property-based + chaos + perf benchmarks",
      "CISO-ready compliance report per scan",
    ],
  },
];

const colorMap = {
  red: {
    badge: "bg-red-500/10 border-red-500/20 text-red-400",
    dot: "bg-red-400",
    card: "border-red-500/15 bg-red-950/10 hover:border-red-500/25",
    bullet: "text-red-400",
  },
  amber: {
    badge: "bg-amber-500/10 border-amber-500/20 text-amber-400",
    dot: "bg-amber-400",
    card: "border-amber-500/15 bg-amber-950/10 hover:border-amber-500/25",
    bullet: "text-amber-400",
  },
  emerald: {
    badge: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    dot: "bg-emerald-400",
    card: "border-emerald-500/15 bg-emerald-950/10 hover:border-emerald-500/25",
    bullet: "text-emerald-400",
  },
};

export default function AiNative() {
  return (
    <section id="features" className="py-24 px-6 border-t border-border/30 bg-[#0a0a12] relative overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-gradient-to-b from-teal-500/6 to-transparent rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="inline-block px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/50 text-xs font-semibold uppercase tracking-widest mb-4">
            Built for the AI Era
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
            AI writes code 10× faster.
            <br />
            <span className="hero-accent-text">It also ships bugs 10× faster.</span>
          </h2>
          <p className="text-white/50 text-lg max-w-2xl mx-auto">
            Cursor, Copilot, Claude — every AI code tool skips the checks that catch the dangerous bugs.
            GateTest was built specifically to audit AI-generated code at scale.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {categories.map((cat) => {
            const c = colorMap[cat.color as keyof typeof colorMap];
            return (
              <div
                key={cat.title}
                className={`rounded-xl border p-6 transition-colors ${c.card}`}
              >
                <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-semibold mb-5 ${c.badge}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                  {cat.title}
                </div>
                <ul className="space-y-2.5">
                  {cat.items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm">
                      <span className={`${c.bullet} text-xs mt-0.5 shrink-0`}>▸</span>
                      <span className="text-white/65 leading-snug">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-12 text-center">
          <p className="text-white/30 text-sm">
            Every tool on the market was built for human developers writing code by hand.
            <br />
            GateTest is the only QA system purpose-built for AI-generated code at velocity.
          </p>
        </div>
      </div>
    </section>
  );
}
