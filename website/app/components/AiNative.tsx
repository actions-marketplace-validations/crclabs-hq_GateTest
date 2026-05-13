const aiIssues = [
  {
    issue: "Hallucinated imports",
    description: "AI invents packages that don't exist. GateTest catches import resolution failures instantly.",
    icon: "?",
  },
  {
    issue: "Hardcoded secrets",
    description: "AI generates example API keys and forgets to remove them. GateTest scans 14 secret patterns.",
    icon: "!",
  },
  {
    issue: "console.log left behind",
    description: "AI debugging artifacts slip into production. GateTest blocks every single one.",
    icon: ">",
  },
  {
    issue: "Missing error handling",
    description: "AI writes the happy path and skips the sad path. GateTest checks every catch block.",
    icon: "x",
  },
  {
    issue: "Incomplete accessibility",
    description: "AI forgets alt text, ARIA labels, and focus management. GateTest enforces WCAG 2.2 AAA.",
    icon: "A",
  },
  {
    issue: "Memory leaks",
    description: "AI adds event listeners and intervals without cleanup. GateTest detects the pattern.",
    icon: "M",
  },
  {
    issue: "Broken links from refactoring",
    description: "AI renames files but misses references. GateTest crawls every internal link.",
    icon: "L",
  },
  {
    issue: "Insecure patterns",
    description: "AI uses eval(), innerHTML, document.write(). GateTest flags every OWASP violation.",
    icon: "S",
  },
];

export default function AiNative() {
  return (
    <section id="features" className="py-24 px-6 border-t border-border/30 grid-bg relative">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent/5 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            Built for the AI Era
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            The first QA system built for
            <span className="gradient-text"> AI-generated code</span>.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Claude, Copilot, Cursor — AI writes code 10x faster, but introduces
            patterns that human-era testing tools weren&apos;t built to catch.
            GateTest was.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {aiIssues.map((item) => (
            <div
              key={item.issue}
              className="rounded-xl p-5 border border-border hover:border-accent/30 bg-surface hover:bg-surface-light transition-all"
            >
              <div className="w-8 h-8 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center font-[var(--font-mono)] font-bold text-accent-light text-sm mb-3">
                {item.icon}
              </div>
              <h3 className="font-semibold text-foreground mb-2 text-sm">{item.issue}</h3>
              <p className="text-xs text-muted leading-relaxed">{item.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-muted text-sm">
            Every tool on the market was built for human developers. GateTest is the only QA system
            purpose-built to catch what AI gets wrong.
          </p>
        </div>
      </div>
    </section>
  );
}
