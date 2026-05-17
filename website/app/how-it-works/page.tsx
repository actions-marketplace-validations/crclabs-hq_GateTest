import Link from "next/link";
import ArchitectureDiagram from "../components/howitworks/ArchitectureDiagram";
import FlywheelTable from "../components/howitworks/FlywheelTable";
import CostTrendChart from "../components/howitworks/CostTrendChart";
import ModuleGrid from "../components/howitworks/ModuleGrid";
import TierTable from "../components/howitworks/TierTable";
import { MODULE_CATEGORIES, totalModuleCount } from "../components/howitworks/modules-data";

const TOTAL_MODULES = totalModuleCount();

const LIMITS = [
  "Doesn't replace a senior engineer's code review. We catch the bugs that have a recognisable shape; humans still own architecture and product judgement.",
  "Doesn't catch logic bugs that need domain context. If your invariant is 'don't ever discount over 30%', no scanner can know that without you telling it.",
  "Doesn't fix bugs that span 5+ files without human review. Multi-file refactors are flagged but require an engineer to drive.",
  "Coverage on Rust, Go, and Java is shallower than JS/TS/Python today. We have language-specific modules for nine non-JS backends but the depth is honestly thinner than our JS coverage.",
  "No on-prem deployment yet. Everything runs against our managed Vercel + Neon stack today. Air-gapped customers are on the roadmap.",
  "No VSCode extension that runs in real time yet. Today's loop is push → CI → PR comment. Editor integration is on the list.",
];

const DATA_FLOW = [
  { label: "Frontend", value: "Next.js 16 (App Router) + Tailwind 4. Server Components everywhere except where interactivity demands client." },
  { label: "Runtime",  value: "Vercel serverless functions. Every function is stateless — no in-memory persistence between requests." },
  { label: "Database", value: "Postgres on Neon. Holds scan_queue, audit log, fix-recipe store, customer sessions." },
  { label: "Payments", value: "Stripe with manual capture. Card is held when you start the scan and charged only after the report ships." },
  { label: "AI layer", value: "Anthropic Claude Sonnet. Our key for managed scans; your key for the self-healing CI bot in your repo." },
  { label: "Git host",  value: "Dual-host: GitHub App webhook and Gluecron Signal Bus. HostBridge abstraction means new hosts plug in without rewiring." },
  { label: "Browser",   value: "Playwright (open-source, Microsoft) — used internally for chaos, explorer, and runtime-error modules. Not a paid competitor; an implementation detail." },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen text-white" style={{ background: "#0a0a12" }}>
      {/* Subtle radial glow at the top */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] opacity-60"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(20, 184, 166, 0.12), transparent 70%)",
        }}
      />

      {/* Top nav strip — matches /compare style for a deep-link feel */}
      <nav className="relative border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <div className="flex items-center gap-6 text-sm">
            <Link href="/" className="text-white/50 hover:text-white transition-colors hidden sm:inline">
              Home
            </Link>
            <a href="#pricing-tiers" className="text-white/50 hover:text-white transition-colors hidden sm:inline">
              Tiers
            </a>
            <Link href="/web" className="text-white/50 hover:text-white transition-colors hidden sm:inline">
              Web scan
            </Link>
            <Link
              href="/web"
              className="px-4 py-2 rounded-lg font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Run a free scan
            </Link>
          </div>
        </div>
      </nav>

      <main className="relative px-6 py-14 sm:py-20 max-w-6xl mx-auto">
        {/* ============================================================
            1. HERO
           ============================================================ */}
        <header className="mb-20">
          <nav className="flex items-center gap-2 text-xs text-white/40 mb-6 font-mono">
            <Link href="/" className="hover:text-white/70 transition-colors">/</Link>
            <span>/</span>
            <span className="text-white/60">how-it-works</span>
          </nav>

          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Architecture, end to end
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
            How GateTest works
          </h1>
          <p className="text-lg sm:text-xl text-white/65 max-w-3xl leading-relaxed mb-4">
            {TOTAL_MODULES} deterministic modules. One Claude pass when it&apos;s worth it. Zero hype.
          </p>
          <p className="text-base text-white/55 max-w-3xl leading-relaxed">
            Most QA scanners are either purely pattern-matched (cheap, noisy) or purely LLM-driven (expensive,
            unpredictable). GateTest is neither. The default scan is a static engine with no AI in the loop —
            predictable, reproducible, no surprise API spend. AI is reserved for fix generation, and even there
            we try three deterministic layers first.
          </p>
        </header>

        {/* ============================================================
            2. ARCHITECTURE DIAGRAM
           ============================================================ */}
        <section className="mb-24" aria-labelledby="architecture">
          <h2 id="architecture" className="text-2xl sm:text-3xl font-bold mb-3">
            The pipeline
          </h2>
          <p className="text-white/55 max-w-3xl mb-8 leading-relaxed">
            Customer push hits one of two ingress points, lands in a single Postgres queue, runs the gate,
            and ships a PR. The same path serves every tier — depth comes from what we layer on top, not
            from a different pipeline.
          </p>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4 sm:p-8">
            <ArchitectureDiagram />
          </div>
          <p className="text-xs text-white/40 mt-3 italic">
            The diagram is hand-rolled SVG. Mermaid would have required adding a dependency, and the rule on
            unapproved dependencies is hard.
          </p>
        </section>

        {/* ============================================================
            3. MODULE GALLERY
           ============================================================ */}
        <section className="mb-24" aria-labelledby="modules-section">
          <h2 id="modules-section" className="text-2xl sm:text-3xl font-bold mb-3">
            The {TOTAL_MODULES} modules
          </h2>
          <p className="text-white/55 max-w-3xl mb-8 leading-relaxed">
            Each module is self-contained, runs in parallel, and emits structured findings. Click a card
            to see a representative finding. Grouped by category for browsability — the actual suite
            assignment lives in <code className="font-mono text-teal-300/80 bg-white/[0.04] px-1.5 py-0.5 rounded text-xs">src/core/config.js</code>.
          </p>

          {/* Category jump nav */}
          <div className="flex flex-wrap gap-2 mb-10">
            {MODULE_CATEGORIES.map((c) => (
              <a
                key={c.id}
                href={`#modules-${c.id}`}
                className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.02] text-white/60 hover:text-white hover:border-white/25 transition-colors"
              >
                {c.title} <span className="text-white/35 ml-1">{c.modules.length}</span>
              </a>
            ))}
          </div>

          <ModuleGrid />
        </section>

        {/* ============================================================
            4. FLYWHEEL DEEP DIVE
           ============================================================ */}
        <section className="mb-24" aria-labelledby="flywheel">
          <h2 id="flywheel" className="text-2xl sm:text-3xl font-bold mb-3">
            The fix flywheel
          </h2>
          <p className="text-white/55 max-w-3xl mb-8 leading-relaxed">
            When the gate produces a finding that you&apos;ve paid to have fixed, our orchestrator
            (<code className="font-mono text-teal-300/80 bg-white/[0.04] px-1.5 py-0.5 rounded text-xs">website/app/lib/try-fix.js</code>)
            walks four layers in order. The first layer that produces a real patch wins. Each layer is bounded
            by a 30-second soft timeout; a crash falls through; a no-op patch is rejected. The whole orchestrator
            never throws.
          </p>

          <FlywheelTable />

          <div className="mt-10 rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4 sm:p-6">
            <h3 className="text-base font-semibold text-white mb-2">Cost trend as recipes accumulate</h3>
            <p className="text-sm text-white/55 mb-4 max-w-2xl leading-relaxed">
              When Claude solves something and the diff is templatey, the
              <code className="mx-1 font-mono text-teal-300/80 bg-white/[0.04] px-1.5 py-0.5 rounded text-xs">auto-distill</code>
              step records a recipe. Next time the same shape appears, the recipe layer wins and Claude is never called.
              The Claude ratio is highest on day one and trends toward single digits over time.
            </p>
            <CostTrendChart />
          </div>
        </section>

        {/* ============================================================
            5. TIERS
           ============================================================ */}
        <section className="mb-24" id="pricing-tiers" aria-labelledby="tiers">
          <h2 id="tiers" className="text-2xl sm:text-3xl font-bold mb-3">
            The four tiers
          </h2>
          <p className="text-white/55 max-w-3xl mb-8 leading-relaxed">
            Same engine, same modules, same queue. The tiers differ in what we layer on top of the
            base scan — and we&apos;re honest about what you don&apos;t get at each tier. &ldquo;no&rdquo; means no.
          </p>

          <TierTable />

          <div className="mt-6 text-xs text-white/45 leading-relaxed max-w-3xl">
            <p>
              <span className="text-white/65 font-semibold">Pay-on-completion</span> at every tier. We hold the card via
              Stripe&apos;s manual-capture flow, run the scan, and only charge after the report ships. If we can&apos;t
              complete it, the hold is released and you pay nothing.
            </p>
          </div>
        </section>

        {/* ============================================================
            6. SELF-HEALING CI
           ============================================================ */}
        <section className="mb-24" aria-labelledby="self-healing">
          <h2 id="self-healing" className="text-2xl sm:text-3xl font-bold mb-3">
            Self-healing CI
          </h2>
          <p className="text-white/55 max-w-3xl mb-6 leading-relaxed">
            Beyond the managed scan, GateTest ships a GitHub Actions workflow that runs in <em>your</em> CI with
            <em> your</em> Anthropic key. When CI breaks, the workflow pipes the failing log through the same
            AST → Rule → Recipe → Claude flywheel, applies the fix, and opens a follow-up PR. Same engine, same
            recipe store, your bill on Anthropic rather than ours.
          </p>

          <div className="rounded-2xl border border-white/[0.08] bg-black/30 overflow-hidden">
            <div className="border-b border-white/[0.06] px-4 py-2.5 flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 text-xs text-white/40 font-mono">.github/workflows/gatetest-self-healing.yml</span>
            </div>
            <pre className="p-5 text-xs sm:text-sm text-white/70 font-mono leading-relaxed overflow-x-auto">
{`name: GateTest Self-Healing CI
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  heal:
    if: \${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx gatetest heal --pr
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN:      \${{ secrets.GITHUB_TOKEN }}`}
            </pre>
          </div>

          <ol className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            {[
              { n: "1", t: "CI fails", d: "Workflow_run trigger fires on conclusion: failure." },
              { n: "2", t: "Logs in", d: "Heal step downloads the failing job's logs and the diff." },
              { n: "3", t: "Flywheel", d: "Same AST → Rule → Recipe → Claude orchestrator runs." },
              { n: "4", t: "Fix PR", d: "Patch lands on a follow-up branch, PR opens against your default." },
            ].map((step) => (
              <li key={step.n} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs text-teal-400">{step.n}</span>
                  <span className="font-semibold text-white text-sm">{step.t}</span>
                </div>
                <p className="text-xs text-white/55 leading-relaxed">{step.d}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ============================================================
            7. DATA FLOW / STACK
           ============================================================ */}
        <section className="mb-24" aria-labelledby="stack">
          <h2 id="stack" className="text-2xl sm:text-3xl font-bold mb-3">
            The stack
          </h2>
          <p className="text-white/55 max-w-3xl mb-8 leading-relaxed">
            We deliberately keep the stack small. Every box below earns its place — no &ldquo;just in case&rdquo;
            services, no orchestration layers we don&apos;t need. The serverless rule is hard: no in-memory state
            between requests, ever.
          </p>

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] divide-y divide-white/[0.05]">
            {DATA_FLOW.map((row) => (
              <div key={row.label} className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3 sm:gap-6 p-5 items-start">
                <div className="font-mono text-sm text-teal-300/85 font-semibold">{row.label}</div>
                <p className="text-sm text-white/65 leading-relaxed">{row.value}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-white/40 mt-4 leading-relaxed max-w-3xl">
            All scan state lives in Postgres or in Stripe&apos;s payment-intent metadata. We never write a Map or
            module-level variable that&apos;s expected to survive across requests — the function instance that
            picked up your second-page poll is not the one that ran your scan.
          </p>
        </section>

        {/* ============================================================
            8. HONEST LIMITS
           ============================================================ */}
        <section className="mb-24" aria-labelledby="limits">
          <h2 id="limits" className="text-2xl sm:text-3xl font-bold mb-3">
            What GateTest doesn&apos;t do (yet)
          </h2>
          <p className="text-white/55 max-w-3xl mb-8 leading-relaxed">
            Every QA vendor promises the moon. Here&apos;s what we don&apos;t deliver today. If any of these are
            blockers for you, the honest answer is &ldquo;not yet.&rdquo;
          </p>

          <ul className="space-y-3">
            {LIMITS.map((limit, i) => (
              <li key={i} className="rounded-xl border border-amber-500/15 bg-amber-500/[0.03] p-4 flex items-start gap-3">
                <span className="text-amber-300/80 font-mono text-xs mt-0.5 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="text-sm text-white/70 leading-relaxed">{limit}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ============================================================
            9. FOOTER CTAs
           ============================================================ */}
        <section className="mb-12" aria-labelledby="cta">
          <h2 id="cta" className="text-2xl sm:text-3xl font-bold mb-3">
            Run it against your code
          </h2>
          <p className="text-white/55 max-w-2xl mb-8 leading-relaxed">
            Architecture is just words until you see the report. The free URL scan takes about ten seconds and
            returns a real health score against your live site.
          </p>

          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/web"
              className="inline-flex items-center justify-center px-6 py-3.5 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Run a free scan now
            </Link>
            <a
              href="https://github.com/ccantynz-alt/gatetest"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center px-6 py-3.5 rounded-xl font-semibold text-sm border border-white/15 text-white/75 hover:border-white/30 hover:text-white transition-colors"
            >
              See the GitHub Action
            </a>
            <a
              href="https://github.com/ccantynz-alt/gatetest/tree/main/docs/proofs"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center px-6 py-3.5 rounded-xl font-semibold text-sm border border-white/15 text-white/75 hover:border-white/30 hover:text-white transition-colors"
            >
              Read the proof docs
            </a>
          </div>
        </section>

        {/* Footer line */}
        <footer className="border-t border-white/[0.06] pt-8 mt-12 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="text-xs text-white/40">
            &copy; {new Date().getFullYear()} GateTest. AI writes fast. GateTest keeps it honest.
          </div>
          <div className="flex gap-5 text-xs text-white/40">
            <Link href="/" className="hover:text-white/70 transition-colors">Home</Link>
            <Link href="/legal/privacy" className="hover:text-white/70 transition-colors">Privacy</Link>
            <Link href="/legal/terms" className="hover:text-white/70 transition-colors">Terms</Link>
            <a href="mailto:hello@gatetest.ai" className="hover:text-white/70 transition-colors">Contact</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
