import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Node.js Security & Quality Scanning — GateTest",
  description:
    "Security headers, SQL injection detection, N+1 queries, resource leaks, SSRF vulnerabilities, ReDoS patterns, race conditions — GateTest covers every Node.js failure mode.",
  keywords: [
    "Node.js security scanning",
    "Node.js code quality",
    "Node.js SSRF detection",
    "Node.js N+1 queries",
    "Express.js security",
    "Node.js race conditions",
    "Node.js resource leaks",
    "Node.js CI gate",
  ],
  alternates: {
    canonical: "https://gatetest.ai/for/nodejs",
  },
  openGraph: {
    title: "Node.js Security & Quality Scanning — GateTest",
    description:
      "Security headers, SQL injection detection, N+1 queries, resource leaks, SSRF vulnerabilities, ReDoS patterns, race conditions — GateTest covers every Node.js failure mode.",
    url: "https://gatetest.ai/for/nodejs",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "What Node.js security issues does GateTest find?",
    a: "GateTest covers the full OWASP Top 10 for Node.js: SSRF (tracking user-controlled input from req.body to fetch()), SQL injection patterns, ReDoS (catastrophic regex that can halt your event loop), TLS validation bypass (rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED=0), cookie security misconfigs (httpOnly: false, secure: false, weak secrets), hardcoded localhost URLs that leak to production, PII in logs (console.log(user), logger.info(req.body)), and more.",
  },
  {
    q: "Does GateTest detect N+1 query problems in Node.js ORMs?",
    a: "Yes. The nPlusOne module covers Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-postgres, MySQL2, and generic db/orm/repo shapes. It finds database calls inside loop bodies — for loops, while loops, .map(), .forEach(), .filter(), .reduce(). It recognises await Promise.all(arr.map(async () => await db.query(...))) as the batched fix pattern and records it as info rather than error.",
  },
  {
    q: "Does GateTest detect resource leaks in Node.js?",
    a: "Yes. The resourceLeak module catches: unclosed fs.createReadStream / createWriteStream (error), fs.open / fs.promises.open file handles that are never closed (warning), WebSocket / EventSource / net.createConnection objects that are never closed (warning), and setInterval calls where the return value is discarded (error — no way to call clearInterval). It recognises stream.pipeline() and stream.finished() as proper cleanup patterns.",
  },
  {
    q: "How does GateTest catch SSRF in Node.js apps?",
    a: "The ssrf module tracks taint from request sources (req.body, req.query, req.params, req.headers) to HTTP client calls (fetch, axios, got, http.request, https.request, needle, superagent, undici, ky). If user input flows to a URL without an intermediate validator (validateUrl(), isValidUrl(), allowedHosts.includes(), new URL(x).hostname check), GateTest flags it as an error. It also flags hardcoded cloud-metadata endpoints (AWS 169.254.169.254, GCP metadata.google.internal).",
  },
  {
    q: "Does GateTest detect race conditions in Node.js?",
    a: "Yes. The raceCondition module catches TOCTOU (check-then-act) patterns: fs.exists()/fs.stat()/fs.access() followed within 15 lines by a destructive fs operation (unlink/rm/rename/chmod/copyFile/truncate) on the same path. For databases, it catches Prisma/Sequelize/Mongoose/TypeORM findFirst/findOne followed by create/update/upsert on the same model without a visible $transaction, ON CONFLICT, or upsert guard — the get-or-create lost-update bug.",
  },
  {
    q: "Does GateTest find ReDoS vulnerabilities in Node.js?",
    a: "Yes. The redos module extracts regex patterns from literal form (/pattern/), new RegExp('...') constructors, and checks for three catastrophic backtracking shapes: nested quantifiers ((a+)+, (.*)*), alternation with overlapping branches inside quantified groups ((a|a)*), and greedy .* sequences in unanchored patterns. It also catches user-controlled regex construction (new RegExp(req.body.pattern)) — a CWE-1333 injection vector.",
  },
];

const nodeModules = [
  {
    name: "ssrf",
    label: "SSRF / URL Validation",
    severity: "error",
    what: "Tracks req.body/query/params → fetch/axios/got. Flags tainted URLs, metadata endpoints (AWS 169.x.x.x, GCP), suspicious webhook vars without validation.",
  },
  {
    name: "nPlusOne",
    label: "N+1 Query Detector",
    severity: "error",
    what: "Database calls inside loops across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-pg. Understands Promise.all(arr.map(async...)) as a fix.",
  },
  {
    name: "raceCondition",
    label: "Race Condition / TOCTOU",
    severity: "error",
    what: "fs.exists → fs.unlink on the same path. ORM findOne → create without $transaction or ON CONFLICT guard. The get-or-create lost-update bug.",
  },
  {
    name: "resourceLeak",
    label: "Resource Leak Detector",
    severity: "error",
    what: "Unclosed streams, file handles, WebSockets, net.createServer. setInterval with discarded return value. Recognises stream.pipeline() as safe cleanup.",
  },
  {
    name: "redos",
    label: "ReDoS / Catastrophic Regex",
    severity: "error",
    what: "Nested quantifiers (a+)+, overlapping alternation (a|a)*, greedy .* in unanchored patterns. User-controlled RegExp construction (CWE-1333).",
  },
  {
    name: "retryHygiene",
    label: "Retry Hygiene",
    severity: "warning",
    what: "while(true) with fetch and no break/max-attempts (unbounded). Constant sleep with no exponential multiplier (no backoff). No Math.random() jitter. Retry-on-4xx without bail.",
  },
  {
    name: "tlsSecurity",
    label: "TLS Bypass Detection",
    severity: "error",
    what: "rejectUnauthorized: false in https.Agent. NODE_TLS_REJECT_UNAUTHORIZED=0 (global nuclear disable). strictSSL: false. insecure: true.",
  },
  {
    name: "cookieSecurity",
    label: "Cookie / Session Security",
    severity: "error",
    what: "httpOnly:false (XSS readable), secure:false (rides over HTTP), weak session secret. Express-session, cookie-parser, next/headers.", // cookie-ok — demo description
  },
  {
    name: "hardcodedUrl",
    label: "Hardcoded URL / Localhost Leak",
    severity: "error",
    what: "localhost / 127.0.0.1 / 0.0.0.0, RFC1918 ranges, .internal/.local/.corp TLDs, staging subdomains in production source code.", // hardcoded-url-ok — demo description
  },
  {
    name: "sqlMigrations",
    label: "SQL Migration Safety",
    severity: "error",
    what: "DROP COLUMN/TABLE, ADD COLUMN NOT NULL without default, SET NOT NULL, CREATE/DROP INDEX without CONCURRENTLY, ALTER TYPE rewrites, TRUNCATE.",
  },
];

export default function NodeJsPage() {
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
          <span className="text-white/60">Node.js</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Runtime-specific scanning
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            Node.js Security
            <br />
            <span className="text-teal-400">& Quality Scanning</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            Node.js has a unique failure-mode profile: SSRF from request-to-fetch data flows,
            N+1 queries hidden inside async loops, race conditions in concurrent request handlers,
            resource leaks from unclosed streams, and ReDoS that can halt the event loop.
            GateTest covers every one.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 mt-8">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Scan My Node.js App — From $29
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See All 90 Modules
            </Link>
          </div>
        </div>

        {/* Module grid */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">Node.js-specific modules</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {nodeModules.map((mod) => (
              <div
                key={mod.name}
                className="rounded-xl p-5 border border-white/[0.08]"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-center justify-between gap-3 mb-2">
                  <code className="text-teal-400 text-xs font-mono">{mod.name}</code>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                    mod.severity === "error"
                      ? "text-red-400 bg-red-500/10 border-red-500/20"
                      : "text-amber-400 bg-amber-500/10 border-amber-500/20"
                  }`}>{mod.severity}</span>
                </div>
                <div className="text-white/80 text-sm font-medium mb-1.5">{mod.label}</div>
                <p className="text-white/45 text-xs leading-relaxed">{mod.what}</p>
              </div>
            ))}
          </div>
        </section>

        {/* The invisible bugs section */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-4">Why these bugs survive code review</h2>
          <p className="text-white/55 text-sm mb-8 leading-relaxed max-w-3xl">
            SSRF, N+1, race conditions, and resource leaks are invisible to linters and most static analysis tools. They require understanding <em>what code does</em>, not just <em>how it looks</em>. GateTest uses data-flow analysis and AI reasoning to find bugs that pattern-matching tools miss entirely.
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                title: "SSRF is invisible to ESLint",
                code: "const url = req.query.webhook;\nfetch(url); // ← SSRF: user controls the target",
                module: "ssrf",
              },
              {
                title: "N+1 looks like normal async code",
                code: "const users = await db.user.findMany();\nfor (const u of users) {\n  // 1 query per user:\n  u.orders = await db.order.findMany({where: {userId: u.id}});\n}",
                module: "nPlusOne",
              },
              {
                title: "Resource leaks are silent",
                code: "// handle never used:\nsetInterval(syncData, 30_000);\n// nothing calls clearInterval",
                module: "resourceLeak",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-xl border border-white/[0.08] p-4"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <div className="text-white/60 text-xs font-medium mb-2">{item.title}</div>
                <pre className="text-white/60 text-xs font-mono bg-black/30 rounded p-3 mb-2 overflow-x-auto leading-relaxed whitespace-pre-wrap">{item.code}</pre>
                <code className="text-teal-400/60 text-xs">→ caught by {item.module}</code>
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
            Find the bugs that survive code review.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            SSRF, N+1, race conditions, resource leaks, ReDoS — GateTest catches every Node.js failure mode. Pay only when results are delivered.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Scan My Node.js App — From $29
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
            <Link href="/for/typescript" className="hover:text-white/60 transition-colors">TypeScript</Link>
            <Link href="/for/python" className="hover:text-white/60 transition-colors">Python</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
