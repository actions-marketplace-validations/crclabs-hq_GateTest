import Link from "next/link";

// gatetest.ai/stack — "One team, three products" page.
//
// Boss Rule #8 — all customer-facing copy below is a draft for Craig's
// final review. Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m
// on 2026-05-13.

export const metadata = {
  title: "One team, three products — GateTest · Gluecron · Crontech",
  description:
    "GateTest audits your code and your site. Gluecron hosts your git. Crontech tells you when something breaks. All built by the same team. Use whichever solves your problem.",
};

export default function StackPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="px-6 py-20 max-w-4xl mx-auto text-center">
        <p className="text-xs uppercase tracking-widest text-accent mb-4 font-semibold">
          One team, three products
        </p>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
          We use these every day.
          <br />
          <span className="text-accent">So you can use them every day.</span>
        </h1>
        <p className="text-lg text-muted max-w-2xl mx-auto leading-relaxed">
          Three independent products. One team behind them. Each one solves a different
          piece of the &quot;running real software in production without losing sleep&quot;
          problem — and they&apos;re designed to be useful on their own or together.
        </p>
      </section>

      <section className="px-6 py-12 max-w-5xl mx-auto">
        <div className="grid lg:grid-cols-3 gap-6">
          {PRODUCTS.map((p) => (
            <div
              key={p.name}
              className={`rounded-2xl border ${
                p.highlighted ? "border-accent/40 bg-accent/5" : "border-border bg-background-alt"
              } p-8 flex flex-col`}
            >
              <div className="flex items-center gap-3 mb-5">
                <div
                  className={`w-10 h-10 rounded-lg ${p.badgeColor} flex items-center justify-center flex-shrink-0`}
                >
                  <span className="text-white font-bold text-sm font-[var(--font-mono)]">
                    {p.badge}
                  </span>
                </div>
                <h2 className="font-bold text-2xl">{p.name}</h2>
              </div>
              <p className="text-base text-foreground leading-relaxed mb-4 font-medium">
                {p.tagline}
              </p>
              <p className="text-sm text-muted leading-relaxed mb-6">{p.body}</p>
              <ul className="text-sm space-y-2 mb-6">
                {p.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <span className="text-accent mt-0.5 font-bold">✓</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto">
                {p.external ? (
                  <a
                    href={p.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent-hover transition-colors"
                  >
                    Visit {p.name} <span aria-hidden>→</span>
                  </a>
                ) : (
                  <Link
                    href={p.href}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent-hover transition-colors"
                  >
                    Open {p.name} <span aria-hidden>→</span>
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-16 max-w-3xl mx-auto border-t border-border">
        <h2 className="text-3xl font-bold mb-6 text-center">Why three products instead of one big one</h2>
        <div className="text-base text-foreground leading-relaxed space-y-4">
          <p>
            We could have built one mega-product. We didn&apos;t, because no real customer wants
            a mega-product. They want{" "}
            <span className="font-semibold">the tool that solves the problem they have right now</span>{" "}
            — and they want to be able to drop it for a different tool tomorrow without unsubscribing
            from anything.
          </p>
          <p>
            So we built three small products that share a philosophy but not a billing surface.
            Use GateTest without ever signing up for Gluecron. Use Crontech without ever touching
            GateTest. Or use all three. The choice stays yours.
          </p>
          <p>
            The shared philosophy: <span className="font-semibold">pay-per-use where it works,
            no-subscription-pressure, and brutally honest about what each tool DOES and DOESN&apos;T do.</span>
          </p>
        </div>
      </section>

      <section className="px-6 py-12 max-w-3xl mx-auto border-t border-border text-center">
        <h2 className="text-2xl font-bold mb-4">How they fit together (if you use more than one)</h2>
        <ul className="text-sm text-muted space-y-3 max-w-2xl mx-auto text-left">
          <li>
            <span className="font-semibold text-foreground">Code on Gluecron, audited by GateTest:</span>{" "}
            push triggers a scan; failing scans block the merge. Same gate story as a GitHub repo,
            but on a git host that Claude actually understands.
          </li>
          <li>
            <span className="font-semibold text-foreground">Scheduled jobs on Crontech, audited by GateTest:</span>{" "}
            the cron / background work that powers your product gets the same QA treatment as your
            request-path code. GateTest scans the job definition; Crontech runs it at the edge.
          </li>
          <li>
            <span className="font-semibold text-foreground">All three:</span>{" "}
            code on Gluecron, gated by GateTest at push-time, scheduled jobs running on Crontech.
            End-to-end coverage with three independent tools, three independent bills, three
            independent failure modes.
          </li>
        </ul>
      </section>
    </main>
  );
}

const PRODUCTS = [
  {
    name: "GateTest",
    badge: "G",
    badgeColor: "bg-accent",
    tagline: "AI writes fast. GateTest keeps it honest.",
    body:
      "QA + security audit for your codebase OR your live website. 101 modules covering security, performance, accessibility, SEO, supply chain, AI safety. Pay per scan, not per seat.",
    bullets: [
      "Free preview shows your top 3 issues",
      "Pay-per-scan from $49 — no subscription required",
      "Same engine scans your code AND your live URL",
      "Plain-language report you can hand to anyone",
    ],
    href: "/",
    external: false,
    highlighted: true,
  },
  {
    name: "Gluecron",
    badge: "Gc",
    badgeColor: "bg-indigo-500",
    tagline: "The git host built around Claude.",
    body:
      "A git host designed from day one for the era when most of the code is being written by AI agents. Programmatic webhook API, agent-friendly auth, Claude-aware tooling. The platform GateTest itself runs on.",
    bullets: [
      "Repos, branches, PRs — done the way Claude expects them",
      "Programmatic webhook registration via REST (no clicking through UIs)",
      "PAT auth that just works for agents",
      "No code-AI-training opt-in question because there's no opt-in",
    ],
    href: "https://gluecron.com",
    external: true,
  },
  {
    name: "Crontech",
    badge: "Ct",
    badgeColor: "bg-amber-500",
    tagline: "AI-native. Edge-first. Zero ops.",
    body:
      "Scheduled jobs, background tasks, and event-driven work that runs at the edge with zero infrastructure to manage. Designed for the agent era — describe what you want done; Crontech runs it.",
    bullets: [
      "Edge-first runtime — close to your users, close to your data",
      "Zero infra to provision, zero on-call rotation",
      "AI-native by design — Claude understands your jobs",
      "Pay only when work actually runs",
    ],
    href: "https://crontech.ai",
    external: true,
  },
];
