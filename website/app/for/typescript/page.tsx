import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "TypeScript Code Quality & Strict Mode Enforcement — GateTest",
  description:
    "GateTest enforces TypeScript strict mode, catches @ts-ignore abuse, detects any-type leaks, and flags tsconfig regressions before they reach production. Auto-fix included.",
  keywords: [
    "TypeScript code quality",
    "TypeScript strict mode enforcement",
    "tsconfig scanning",
    "@ts-ignore detection",
    "TypeScript any type",
    "TypeScript CI gate",
    "TypeScript import cycles",
    "TypeScript security",
  ],
  alternates: {
    canonical: "https://gatetest.ai/for/typescript",
  },
  openGraph: {
    title: "TypeScript Code Quality & Strict Mode Enforcement — GateTest",
    description:
      "GateTest enforces TypeScript strict mode, catches @ts-ignore abuse, detects any-type leaks, and flags tsconfig regressions before they reach production.",
    url: "https://gatetest.ai/for/typescript",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "How does GateTest enforce TypeScript strict mode?",
    a: "GateTest's typescriptStrictness module walks every tsconfig.json in your project (including JSONC with // comments, tsconfig.app.json, tsconfig.node.json). It flags strict: false (error — disables all strict checks at once), noImplicitAny: false (error — allows untyped code), skipLibCheck: true (warning — hides type errors in dependencies), strictNullChecks: false (warning — allows null/undefined anywhere), and strictFunctionTypes: false (warning — breaks function parameter type safety).",
  },
  {
    q: "Can GateTest detect @ts-ignore abuse?",
    a: "Yes. The typescriptStrictness module flags @ts-nocheck at the file level (error — suppresses all type checking in that file) and @ts-ignore / @ts-expect-error annotations that have no explanatory comment on the same line (warning — a reason-less suppress is a ticking time bomb). Test files (*.test.ts, *.spec.ts) and declaration files (*.d.ts) are exempt — these legitimately need type flexibility.",
  },
  {
    q: "Does GateTest find unused TypeScript exports?",
    a: "Yes. The deadCode module detects exported symbols that nothing in the codebase imports, files that nothing imports, and commented-out code blocks of 10+ lines. It understands Next.js App Router conventions so page.tsx, layout.tsx, and route.ts exports are never false-positively flagged.",
  },
  {
    q: "How does GateTest detect circular imports in TypeScript projects?",
    a: "The importCycle module builds a dependency graph from your .ts and .tsx files — resolving relative specifiers through extension fallback and ./x/index.ts lookup. It uses Tarjan's strongly-connected-component algorithm to find every cycle of 2+ files. Type-only imports (import type, export type) are correctly excluded — they're erased at build time and can't cause runtime TDZ errors.",
  },
  {
    q: "Does GateTest catch async/await mistakes in TypeScript?",
    a: "Several modules cover this. asyncIteration catches .forEach(async ...) (warning — forEach doesn't await), .filter(async ...) (error — Promise is always truthy, predicate is meaningless), .reduce(async ...) (error — accumulator becomes a Promise chain), and .map(async ...) not wrapped in Promise.all (warning — unwrapped Promise array). errorSwallow catches fire-and-forget .save()/.send()/.commit() calls without await or .catch().",
  },
  {
    q: "Does GateTest detect money/float precision bugs in TypeScript?",
    a: "Yes. The moneyFloat module flags money-named variables (price, total, amount, tax, fee, subtotal, balance, and currency codes usd/eur/gbp/etc.) assigned from parseFloat() or Number() — both are IEEE-754 floating-point and will accumulate rounding errors in financial calculations. Safe if your file imports decimal.js, big.js, bignumber.js, or dinero.js.",
  },
];

const tsModules = [
  {
    name: "typescriptStrictness",
    checks: ["strict: false in tsconfig", "noImplicitAny: false", "@ts-nocheck (file-wide suppress)", "Unreasoned @ts-ignore", "Exported signatures with : any", "as any casts in source"],
  },
  {
    name: "importCycle",
    checks: ["Circular import chains (Tarjan SCC)", "Self-imports", "Type-only imports correctly excluded", "Extension fallback resolution", "index.ts re-export cycles"],
  },
  {
    name: "deadCode",
    checks: ["Unused exported functions/classes", "Orphaned files (nothing imports)", "10+ line commented-out blocks", "Next.js App Router convention-aware"],
  },
  {
    name: "asyncIteration",
    checks: [".forEach(async ...) — swallowed promises", ".filter/.some/.every(async ...) — always truthy", ".reduce(async ...) — silent serialization", ".map(async ...) without Promise.all"],
  },
  {
    name: "errorSwallow",
    checks: ["Empty catch {} blocks", "catch blocks that only console.log", ".catch(() => {}) / .catch(noop)", "Fire-and-forget .save()/.send()/.commit()"],
  },
  {
    name: "moneyFloat",
    checks: ["parseFloat() on money-named variables", "Number() on price/total/amount", ".toFixed(0) / .toFixed(1) on money vars", "Safe if decimal.js / big.js imported"],
  },
];

export default function TypeScriptPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <div className="min-h-screen" style={{ background: "#0a0a12" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <Link href="/" className="text-sm text-white/50 hover:text-white transition-colors">
            &larr; Back to GateTest
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">For</span>
          <span>/</span>
          <span className="text-white/60">TypeScript</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Language-specific scanning
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            TypeScript Code Quality
            <br />
            <span className="text-teal-400">& Strict Mode Enforcement</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            TypeScript gives you a type system. GateTest makes sure it stays honest — catching
            tsconfig regressions, @ts-ignore abuse, any-type leaks, circular imports, async
            anti-patterns, and 60+ more failure modes before they reach production.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 mt-8">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Scan My TypeScript Repo — From $29
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See All 90 Modules
            </Link>
          </div>
        </div>

        {/* The strictness erosion problem */}
        <section className="mb-16 rounded-xl border border-amber-500/20 p-6" style={{ background: "rgba(245,158,11,0.05)" }}>
          {/* fake-fix-ok — demo page showing examples of what GateTest catches */}
          <h2 className="text-lg font-semibold text-amber-300 mb-3">The strictness erosion problem</h2>
          <p className="text-white/60 text-sm mb-4 leading-relaxed">
            TypeScript strict mode exists to catch a whole class of runtime errors at compile time.
            But it&rsquo;s trivially easy to erode: one PR adds <code className="text-amber-300 bg-amber-500/10 px-1 rounded text-xs">{'// @ts-ignore'}</code> to unblock a merge,
            another sets <code className="text-amber-300 bg-amber-500/10 px-1 rounded text-xs">skipLibCheck: true</code> to silence a noisy dependency,
            a third disables <code className="text-amber-300 bg-amber-500/10 px-1 rounded text-xs">strictNullChecks</code> to speed up a deadline.
            Six months later, the type system is decorative.
          </p>
          <p className="text-white/60 text-sm leading-relaxed">
            GateTest makes strictness erosion impossible to merge silently — every tsconfig regression
            and suppression annotation is a gate failure that blocks the PR.
          </p>
        </section>

        {/* TS modules */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">TypeScript-specific modules</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {tsModules.map((mod) => (
              <div
                key={mod.name}
                className="rounded-xl p-5 border border-white/[0.08]"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <code className="text-teal-400 text-sm font-mono block mb-3">{mod.name}</code>
                <ul className="space-y-1.5">
                  {mod.checks.map((check) => (
                    <li key={check} className="flex items-start gap-2 text-xs text-white/55">
                      <span className="text-emerald-400/70 shrink-0 mt-0.5">&#10003;</span>
                      {check}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Code examples of what gets caught */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">What GateTest catches in TypeScript</h2>
          <div className="space-y-4">
            {[
              {
                code: '// tsconfig.json\n{ "compilerOptions": { "strict": false } }',
                module: "typescriptStrictness",
                severity: "error",
                fix: "Remove strict: false to re-enable all strict type checks",
              },
              {
                code: 'const cost = parseFloat(req.body.amount);\nthis.subtotal = parseFloat(rawAmount);', // money-float-ok — demo description
                module: "moneyFloat",
                severity: "error",
                fix: "Use Decimal or Big for financial calculations — IEEE-754 float loses cents at scale",
              },
              {
                code: 'users.forEach(async (user) => {\n  await sendEmail(user.email);\n});',
                module: "asyncIteration",
                severity: "warning",
                fix: "await Promise.all(users.map(async (user) => sendEmail(user.email)))",
              },
              {
                code: '// @ts-ignore\nconst result = dangerousFunction();',
                module: "typescriptStrictness",
                severity: "warning",
                fix: "Add explanation: // @ts-ignore: dangerousFunction is untyped — fix in #1234",
              },
            ].map((item) => (
              <div
                key={item.code}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                    item.severity === "error"
                      ? "text-red-400 bg-red-500/10 border-red-500/20"
                      : "text-amber-400 bg-amber-500/10 border-amber-500/20"
                  }`}>{item.severity}</span>
                  <code className="text-teal-400/70 text-xs">{item.module}</code>
                </div>
                <pre className="text-white/70 text-xs font-mono bg-black/30 rounded-lg p-3 mb-3 overflow-x-auto leading-relaxed">{item.code}</pre>
                <p className="text-white/40 text-xs">
                  <span className="text-emerald-400">Fix: </span>{item.fix}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqItems.map((item) => (
              <div
                key={item.q}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <h3 className="text-white font-semibold mb-3 leading-snug">{item.q}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            Keep TypeScript strict. Ship with confidence.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Gate every PR against strictness regressions, circular imports, async anti-patterns, and 60+ more failure modes. Pay only when results are delivered.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Scan My TypeScript Repo — From $29
          </Link>
          <p className="text-white/30 text-xs mt-6">
            Card hold only. Charged after successful scan delivery.
          </p>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8 mt-16">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex items-center gap-6">
            <Link href="/for/nextjs" className="hover:text-white/60 transition-colors">Next.js</Link>
            <Link href="/for/nodejs" className="hover:text-white/60 transition-colors">Node.js</Link>
            <Link href="/for/python" className="hover:text-white/60 transition-colors">Python</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
