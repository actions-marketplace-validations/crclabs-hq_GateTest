/**
 * Module catalogue grouped by category for the /how-it-works page.
 *
 * Source of truth: `node bin/gatetest.js --list` against src/core/registry.js
 * at v1.42.0 (102 modules). Descriptions match the registered module
 * `description` field (kept short for card display).
 *
 * Examples are honest representative findings each module emits, drawn from
 * the module source or the live proof docs under docs/proofs/.
 */

export type ModuleDef = {
  name: string;
  description: string;
  example: string;
};

export type ModuleCategory = {
  id: string;
  title: string;
  blurb: string;
  modules: ModuleDef[];
};

export const MODULE_CATEGORIES: ModuleCategory[] = [
  {
    id: "source-quality",
    title: "Source & quality",
    blurb: "The foundation. Catches the bugs every linter and compiler should have caught but didn't.",
    modules: [
      { name: "syntax", description: "Validates JS, TS, JSON, YAML, CSS, HTML.", example: "Unclosed bracket at src/api/handler.ts:148" },
      { name: "lint", description: "ESLint, Stylelint, language-aware style rules.", example: "Unexpected console statement at src/db.ts:42" },
      { name: "codeQuality", description: "console.log, debugger, TODO/FIXME, eval, innerHTML, complexity.", example: "innerHTML assignment found at components/Comment.tsx:88" },
      { name: "deadCode", description: "Unused exports across JS/TS/Python, orphaned files, rotting commented-out blocks.", example: "Export 'parseLegacyToken' in src/auth.ts has no importers" },
      { name: "typescriptStrictness", description: "tsconfig regressions, @ts-ignore abuse, any-leak detection on exported signatures.", example: "strict: false in tsconfig.json — implicit-any leaks across 47 files" },
      { name: "documentation", description: "README, CHANGELOG, LICENSE, JSDoc coverage, env documentation.", example: "Missing README section: Installation" },
      { name: "duplicateCode", description: "Copy-pasted blocks that should be extracted into utilities.", example: "16-line block duplicated 4x across src/handlers/" },
      { name: "importCycle", description: "Circular dependencies that cause runtime TDZ / undefined-import bugs.", example: "Cycle: src/user.ts → src/post.ts → src/user.ts" },
      { name: "asyncIteration", description: "Async callbacks handed to .reduce/.filter/.some/.every/.forEach/.map where Promise semantics silently break.", example: ".filter(async x => await isValid(x)) — predicate is a Promise, always truthy" },
      { name: "datetimeBug", description: "Naive datetimes, JS 0-vs-1 month, moment-legacy.", example: "datetime.now() without tz= at jobs/scheduler.py:31" },
      { name: "moneyFloat", description: "IEEE-754 precision loss on currency-named variables.", example: "parseFloat(amount) on trust-account money in TrustActions.tsx" },
      { name: "homoglyph", description: "Trojan Source bidi overrides, Cyrillic/Greek letters in Latin identifiers, zero-width chars.", example: "Cyrillic 'а' (U+0430) inside identifier `data` at src/parser.ts:212" },
    ],
  },
  {
    id: "security",
    title: "Security",
    blurb: "OWASP-grade scanning that goes beyond CVE lookups into your actual code paths.",
    modules: [
      { name: "security", description: "OWASP patterns, XSS, SQL injection, innerHTML, shell exec, Docker misconfigs.", example: "exec(req.body.cmd) at api/run.ts:54 — command injection" },
      { name: "secrets", description: "AWS keys, GitHub tokens, Stripe keys, passwords, private keys, DB strings.", example: "AKIA[redacted] hardcoded in config/aws.ts" },
      { name: "secretRotation", description: "Long-lived credentials in git, .env drift, placeholder/real example mismatch.", example: "API_KEY in .env has been unchanged for 412 days" },
      { name: "ssrf", description: "User-controlled URLs handed to fetch/axios/got/node-http without validation.", example: "fetch(req.query.url) with no allowlist at api/proxy.ts:18" },
      { name: "tlsSecurity", description: "rejectUnauthorized:false, verify=False, NODE_TLS_REJECT_UNAUTHORIZED=0.", example: "rejectUnauthorized: false in production https.Agent" },
      { name: "cookieSecurity", description: "httpOnly:false, weak session secrets, SESSION_COOKIE_* misconfigs.", example: "session cookie httpOnly: false — XSS becomes session takeover" },
      { name: "redos", description: "Catastrophic-regex detector: nested quantifiers, overlapping alternation, user-controlled patterns.", example: "(a+)+ at src/validator.ts:30 — catastrophic backtracking" },
      { name: "authBypass", description: "Routes missing authentication.", example: "/api/admin/users has no middleware guard" },
      { name: "crossFileTaint", description: "Cross-file taint analysis — user input → dangerous sinks across module boundaries.", example: "req.body.path → fs.readFile via 3 hops, no validation" },
      { name: "webhookPayload", description: "Webhook handlers that use req.body without validation.", example: "Stripe webhook handler reads req.body.amount without zod parse" },
      { name: "logPii", description: "Credentials, tokens, and request objects logged in plaintext.", example: "console.log(user) at auth/login.ts:88 — leaks bcrypt hash" },
      { name: "wpExposedFiles", description: "WordPress: sensitive files exposed via public webroot (wp-config.php.bak, debug.log, .git, .env, SQL backups).", example: "wp-config.php.bak reachable at /wp-config.php.bak (HTTP 200)" },
      { name: "wpXmlrpcExposed", description: "WordPress: /xmlrpc.php exposed (brute-force amplification + DDoS reflector + auth-bypass surface).", example: "/xmlrpc.php returns 200 — disable or block at WAF" },
      { name: "wpMalwarePatterns", description: "WordPress: rendered HTML/JS scanned for known malware signatures (eval(atob), hidden iframes, base64 payloads).", example: "eval(atob(...)) found in footer script — likely compromised" },
      { name: "wpAdminProtection", description: "WordPress: /wp-admin and /wp-login.php checked for rate limit / WAF / 2FA / cookie hardening.", example: "/wp-login.php has no rate limiting — brute-force open" },
    ],
  },
  {
    id: "reliability",
    title: "Reliability",
    blurb: "The bugs that don't break on your machine but break in production at 3am.",
    modules: [
      { name: "errorSwallow", description: "Empty catch, .catch(noop), callback-err ignored, floating promises, global silent handlers.", example: "Empty catch block at db/save.ts:114 — error swallowed" },
      { name: "nPlusOne", description: "Database calls inside loops across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle.", example: "await prisma.post.findUnique inside arr.map at feed.ts:42" },
      { name: "retryHygiene", description: "Tight retry loops, no backoff, unbounded retry, retry-on-4xx across fetch/axios/got/node-http.", example: "while(true) retry with no jitter at api/upload.ts:88" },
      { name: "raceCondition", description: "TOCTOU, get-or-create anti-pattern, lost-update on counters.", example: "fs.exists() then fs.unlink() — same path, symlink-race vector" },
      { name: "resourceLeak", description: "Unclosed streams, file handles, intervals, sockets across fs/net/ws/events.", example: "fs.createReadStream never piped or closed at importer.ts:31" },
      { name: "envVars", description: "process.env / os.environ reads cross-referenced with .env.example and CI env blocks.", example: "STRIPE_SECRET_KEY read in code but missing from .env.example" },
      { name: "cronExpression", description: "Invalid / impossible / too-frequent cron strings (Feb 30, * * * * *, typo aliases).", example: "0 0 30 2 * — Feb 30 never fires, silent killer" },
      { name: "featureFlag", description: "Stale flags collapsed into constants and dead-branch conditionals.", example: "if (true) wrapping 200 lines of code at src/checkout.ts:14" },
      { name: "intentVerification", description: "AI checks that the diff matches the commit message / PR description.", example: "PR titled 'fix typo' touches 18 files across 3 directories" },
      { name: "regressionPredictor", description: "AI predicts which files this PR is most likely to break.", example: "Confidence 87%: this change will break tests in checkout/" },
      { name: "rollbackHonesty", description: "Rollback Honesty Checker — verifies advertised rollback path actually rolls back.", example: "deploy.sh has no rollback function despite docs claiming one" },
    ],
  },
  {
    id: "web-ux",
    title: "Web & UX",
    blurb: "Surfacing the user-visible problems static analysis usually pretends don't exist.",
    modules: [
      { name: "accessibility", description: "WCAG 2.2 AAA — missing alt text, ARIA labels, keyboard traps, heading hierarchy.", example: "Heading skip h1 → h3 at /pricing (WCAG 1.3.1)" },
      { name: "performance", description: "Dependency count, bundle size analysis, image optimisation checks.", example: "Hero image 3.4MB unoptimised — LCP penalty" },
      { name: "visual", description: "Visual & UI Regression Testing.", example: "Hero CTA shifted 14px between deploys" },
      { name: "seo", description: "Meta tags, Open Graph, structured data, robots.txt, canonical URLs.", example: "Missing canonical on /compare/snyk" },
      { name: "links", description: "Every broken href — dead anchors, placeholder links, 404s.", example: "/docs/guide returns 404 from footer link" },
      { name: "compatibility", description: "Browser matrix validation. Modern API and CSS features without polyfills.", example: ":has() selector at safari < 15.4 — partial support" },
      { name: "e2e", description: "End-to-End Test Execution.", example: "Checkout flow times out at payment step" },
      { name: "liveCrawler", description: "Live site crawl — 404 / 500 / broken-image / redirect-chain on the live URL.", example: "/blog/old-post → 3 redirects → 404" },
      { name: "explorer", description: "Autonomous Interactive Element Explorer — clicks every button + form + dropdown via Playwright.", example: "Submit button on /signup raises uncaught TypeError" },
      { name: "runtimeErrors", description: "Live browser runtime errors — uncaught JS, console.error/warn, network 4xx/5xx, CSP violations, hydration mismatches.", example: "Hydration mismatch: server rendered 'Dec', client rendered 'Jan'" },
      { name: "chaos", description: "Chaos & Resilience Testing — slow network, API failure, offline, missing resources, server timeouts.", example: "App freezes on 3G simulation — no loading state shown" },
      { name: "webHeaders", description: "CSP/HSTS/XFO/CORS misconfig across Next.js, Vercel, Netlify, Express, Fastify, nginx.", example: "CSP missing — defaults to inline-everything" },
      { name: "cacheHeaders", description: "Cache Headers & CDN Configuration.", example: "/api/user has Cache-Control: public — PII cacheable at CDN" },
    ],
  },
  {
    id: "infrastructure",
    title: "Infrastructure",
    blurb: "Catches the supply-chain takeovers, container exploits, and CI/CD foot-guns.",
    modules: [
      { name: "dependencies", description: "Supply-chain hygiene across npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, Gradle.", example: "left-pad in package.json pinned to 'latest' — supply-chain risk" },
      { name: "dockerfile", description: "Root user, :latest tags, curl|sh, apt hygiene, secrets-in-layers, cache bloat.", example: "USER not set — container runs as root" },
      { name: "ciSecurity", description: "GitHub Actions hardening — action pinning, pwn-request, shell injection, secrets-in-logs, permissions.", example: "actions/checkout@v4 unpinned to SHA — supply-chain risk" },
      { name: "ciParamValidator", description: "Validates GitHub Actions with: inputs against action schemas.", example: "actions/upload-artifact: invalid input 'retention' (typo of 'retention-days')" },
      { name: "shell", description: "Shell script security — curl|sh, unsafe rm, eval injection, hardcoded secrets, set -e, POSIX compliance.", example: "rm -rf $VAR with no quoting at scripts/clean.sh:14" },
      { name: "bashSafety", description: "Bash / Shell Error-Swallow Detector.", example: "Pipeline lacks set -o pipefail — silent failure" },
      { name: "sqlMigrations", description: "Drop column/table, non-concurrent indexes, NOT NULL without default, blocking constraints, rolling-deploy renames.", example: "ALTER TABLE users ADD COLUMN email NOT NULL — blocks writes" },
      { name: "terraform", description: "Public buckets, wildcard ingress, hardcoded secrets, missing encryption, IAM wildcards.", example: "aws_s3_bucket.acl = 'public-read' on customer-data bucket" },
      { name: "kubernetes", description: "Privileged pods, host namespaces, :latest images, missing limits/probes, dangerous caps.", example: "privileged: true in production deployment" },
      { name: "systemd", description: "Systemd Unit File Validator.", example: "Service has no Restart= policy — won't recover from crash" },
      { name: "deployScriptValidator", description: "Health-check URL consistency.", example: "deploy.sh checks :3000 but service listens on :8080" },
      { name: "serviceConsistency", description: "ExecStart / Procfile / PM2 vs package.json start script.", example: "Procfile runs `node dist/server.js`, package.json runs `node server.js`" },
      { name: "deployContract", description: "Deploy Contract Validator.", example: "Vercel runtime=edge but route uses fs module" },
      { name: "deployReadiness", description: "Aggregate 0-100 deployment confidence score.", example: "Deploy readiness: 62/100 — 3 critical, 8 high open" },
      { name: "nativeBundlerGuard", description: "Native Node addons that cannot be bundled.", example: "import sharp — native binary not bundleable on Vercel edge" },
      { name: "bundleSize", description: "JS bundles exceeding size budgets.", example: "main.js 412 KB gzip — budget is 200 KB" },
      { name: "envIntegrity", description: "Env-File Integrity Linter.", example: ".env has duplicate STRIPE_KEY entries — last wins silently" },
      { name: "promptSafety", description: "Browser-exposed API keys, unbounded max_tokens, prompt-injection surfaces, deprecated models.", example: "NEXT_PUBLIC_ANTHROPIC_API_KEY in browser bundle" },
    ],
  },
  {
    id: "developer-hygiene",
    title: "Developer hygiene",
    blurb: "Pulls bad-process bugs out of CI before they cost a 90-minute review.",
    modules: [
      { name: "prSize", description: "Blocks unreviewably-large pull requests (files / lines / sprawl across top-level dirs).", example: "PR touches 142 files, 3,400 lines across 6 top-level dirs" },
      { name: "prQuality", description: "Weak commit messages, missing tests, mixed deps+code.", example: "Commit message 'fix' on a 200-line change" },
      { name: "flakyTests", description: "Committed .only/.skip, real clock/network/timers, env leaks, self-admitted flakes.", example: "describe.only( found in tests/checkout.test.ts" },
      { name: "fakeFixDetector", description: "AI-generated symptom patches — skipped tests, swallowed errors, dead code.", example: "Test changed from expect(x).toBe(2) to .toBe.any() — patching test, not bug" },
      { name: "hardcodedUrl", description: "localhost / 127.0.0.1 / RFC1918 / internal TLDs / non-TLS URLs leaking into production.", example: "API_BASE='http://localhost:3000' in production build" },
      { name: "openapiDrift", description: "Routes defined in code missing from openapi.yaml, and spec paths with no matching handler.", example: "GET /api/v2/orders defined in code but absent from spec" },
      { name: "trpcContract", description: "tRPC procedure definitions vs frontend call sites.", example: "Frontend calls trpc.user.delete — procedure removed in server" },
      { name: "monorepoConstraints", description: "Enforces package boundary rules in apps/ packages/ libs/.", example: "apps/web imports from apps/admin — boundary violation" },
      { name: "zodSchemaPresence", description: "React components without runtime prop validation.", example: "<Checkout> exported with no zod parse on prop input" },
      { name: "dataIntegrity", description: "Migration safety, SQL injection patterns, PII in logs, database schema validation.", example: "Migration drops column 'email' with no backfill" },
    ],
  },
  {
    id: "ai-advanced",
    title: "AI & advanced",
    blurb: "Where deterministic scanning stops and reasoning starts. Used sparingly, not by default.",
    modules: [
      { name: "aiReview", description: "Claude reads your code and finds real bugs — not patterns, actual understanding.", example: "Token refresh races with logout — second auth call uses dead token" },
      { name: "agentic", description: "Memory-driven AI investigation — picks hypotheses from past scans, walks the code.", example: "Recurring null-deref in user.profile — root cause traced to login flow" },
      { name: "memory", description: "Codebase memory — compounding intelligence across scans (issue history + fix patterns).", example: "This file had 14 prior findings — focus areas: auth, session" },
      { name: "aiHallucination", description: "Fake imports, invented APIs, non-existent methods.", example: "import { useReact } from 'react' — no such export" },
      { name: "architectureDrift", description: "AI flags code that violates documented architectural conventions.", example: "src/api/orders.ts bypasses repository layer — direct DB access" },
      { name: "mutation", description: "Modifies your source code to verify your tests actually catch bugs.", example: "Mutated return true → return false, 11/11 tests still pass" },
    ],
  },
  {
    id: "scanning-testing",
    title: "Scanning & testing",
    blurb: "The classic suite — unit, integration, end-to-end — wired into the same gate as everything else.",
    modules: [
      { name: "unitTests", description: "Unit Test Execution.", example: "tests/cart.test.ts: 14 failed, 218 passed, 0 skipped" },
      { name: "integrationTests", description: "Integration Test Execution.", example: "Order placement → payment → fulfilment: 1 failure at fulfilment step" },
    ],
  },
  {
    id: "language-coverage",
    title: "Language coverage",
    blurb: "Nine non-JS language backends. Same engine, language-aware patterns.",
    modules: [
      { name: "python", description: "eval/exec, bare-except, SQL injection, pickle.", example: "pickle.loads(request.data) at api/users.py:12 — RCE vector" },
      { name: "go", description: "Ignored errors, panics, goroutine hygiene.", example: "_, err := db.Query(...) — err discarded at db.go:88" },
      { name: "rust", description: "unwrap/panic/todo, unsafe block review.", example: ".unwrap() on Option in production code at src/auth.rs:24" },
      { name: "java", description: "System.out, broad catches, empty catches.", example: "catch (Exception e) {} at OrderService.java:301" },
      { name: "ruby", description: "eval, shell injection, bare rescue.", example: "system(\"convert #{input}\") — shell injection at uploader.rb:18" },
      { name: "php", description: "eval, legacy mysql_, XSS, debug output.", example: "mysql_query() deprecated API at legacy/db.php:42" },
      { name: "csharp", description: "Console.WriteLine, empty catches.", example: "Empty catch in OrderController.cs:189 — exception swallowed" },
      { name: "kotlin", description: "!!, TODO(), println.", example: "user.profile!! at HomeFragment.kt:71 — NPE risk" },
      { name: "swift", description: "fatalError, try!, force-unwrap.", example: "try! JSONDecoder().decode(...) in production at Network.swift:23" },
    ],
  },
  {
    id: "wp-specific",
    title: "WordPress",
    blurb: "Live-URL probes for the wp.gatetest.ai product. Run against any public WordPress site.",
    modules: [
      { name: "wpVersionLeak", description: "Where the site leaks its core version (readme.html, meta generator, RSS feed, CSS/JS ver=).", example: "Meta generator: 'WordPress 5.8.1' — readable from view-source" },
      { name: "wpPluginCveCheck", description: "Detects installed plugins via fingerprinting and flags any with known CVEs.", example: "elementor 3.5.2 detected — CVE-2023-XXXX critical" },
      { name: "wpUserEnumerate", description: "Checks if usernames can be enumerated via /?author=1, /wp-json/wp/v2/users, /author/admin/.", example: "/?author=1 reveals login 'admin' via redirect" },
      { name: "wpPhpVersionEol", description: "Detects the running PHP version and flags it if end-of-life.", example: "PHP 7.4 detected — EOL since 2022, no security patches" },
      { name: "wpThemeAbandonment", description: "Detects the active theme and flags it if abandoned, deprecated, or carrying known CVEs.", example: "Theme 'oldtheme' last updated 2019 — abandoned" },
      { name: "wpBackupValidation", description: "Whether a backup plugin is installed AND whether any backup files are publicly exposed.", example: "/backup-2024-01.zip reachable (HTTP 200) — full-site dump exposed" },
    ],
  },
];

export function totalModuleCount(): number {
  return MODULE_CATEGORIES.reduce((acc, c) => acc + c.modules.length, 0);
}
