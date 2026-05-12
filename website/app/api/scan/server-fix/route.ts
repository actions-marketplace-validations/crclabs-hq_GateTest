/**
 * Server Fix Generator — produce ready-to-paste configs for server scan issues.
 *
 * POST /api/scan/server-fix
 * Body: { hostname: string, modules: ModuleResult[] }
 *
 * Returns config snippets the user can paste into their server setup.
 * Covers: security headers, HSTS, CSP, DMARC, SPF, compression, redirects.
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";

// Phase 3.5 — executive summary composer. Synthesises diagnoses +
// chains + scan stats into a single CTO-readable report.
 
const { composeExecutiveSummary, renderExecutiveSummary } = require("@/app/lib/executive-summary") as {
  composeExecutiveSummary: (opts: {
    scanStats?: { modulesPassed?: number; modulesTotal?: number; errors?: number; warnings?: number; checksPerformed?: number; durationMs?: number };
    topFindings?: Array<{ detail: string; module?: string; severity?: string }>;
    chains?: Array<{ title: string; severity: string; impact: string }>;
    hostname?: string;
    askClaudeForSummary: (prompt: string) => Promise<string>;
  }) => Promise<{
    ok: boolean;
    sections: { headline: string; posture: string; topActions: string; workingWell: string; recommendedNext: string } | null;
    reason: string | null;
  }>;
  renderExecutiveSummary: (
    result: {
      ok: boolean;
      sections: { headline: string; posture: string; topActions: string; workingWell: string; recommendedNext: string } | null;
      reason?: string | null;
    } | null,
    opts?: { hostname?: string }
  ) => string;
};

// Phase 3.2 — cross-finding correlator. Identifies attack chains
// across the full findings set — combinations that are materially
// worse than the worst individual finding.
 
const { correlateFindings, renderCorrelationReport } = require("@/app/lib/cross-finding-correlator") as {
  correlateFindings: (opts: {
    findings: Array<{ detail: string; module?: string; severity?: string }>;
    hostname?: string;
    askClaudeForCorrelation: (prompt: string) => Promise<string>;
    maxFindings?: number;
  }) => Promise<{
    ok: boolean;
    chains: Array<{ title: string; severity: string; findingNumbers: number[]; findingsInvolved: string[]; impact: string; fixOrder: string }>;
    summary: string;
    reason: string | null;
  }>;
  renderCorrelationReport: (result: {
    ok: boolean;
    chains: Array<{ title: string; severity: string; findingNumbers: number[]; findingsInvolved: string[]; impact: string; fixOrder: string }>;
    summary?: string;
    reason?: string | null;
  } | null) => string;
};

// Phase 3.1 — Nuclear diagnoser. Replaces the category-matched
// shell-command templates below with real Claude-driven diagnosis
// when the caller is on the $399 Nuclear tier.
 
const { diagnoseFindings, renderDiagnosesReport } = require("@/app/lib/nuclear-diagnoser") as {
  diagnoseFindings: (opts: {
    findings: Array<{ detail: string; module?: string; severity?: string }>;
    hostname?: string;
    scanContext?: { platform?: string; stack?: string[] };
    askClaudeForDiagnosis: (prompt: string) => Promise<string>;
    maxFindings?: number;
  }) => Promise<{
    diagnoses: Array<{ finding: { detail: string; module?: string; severity?: string }; ok: boolean; diagnosis: { explanation: string; rootCause: string; recommendation: string; platformNotes: Record<string, string> } | null; reason: string | null }>;
    summary: string;
  }>;
  renderDiagnosesReport: (
    diagnoses: Array<{ finding: { detail: string; module?: string; severity?: string }; ok: boolean; diagnosis: { explanation: string; rootCause: string; recommendation: string; platformNotes: Record<string, string> } | null; reason: string | null }>,
    summary: string
  ) => string;
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

interface ModResult {
  name: string;
  label?: string;
  status: string;
  details: string[];
}

interface FixSnippet {
  platform: string;
  title: string;
  code: string;
  instructions: string;
}

function generateHeaderFixes(details: string[]): FixSnippet[] {
  const missing = new Set<string>();
  for (const d of details) {
    if (d.includes("Missing HSTS") || d.toLowerCase().includes("missing strict-transport")) missing.add("hsts");
    if (d.includes("Missing X-Content-Type-Options")) missing.add("xcontent");
    if (d.includes("Missing X-Frame-Options")) missing.add("xframe");
    if (d.includes("Missing CSP") || d.includes("Missing Content-Security-Policy")) missing.add("csp");
    if (d.includes("Missing Referrer-Policy")) missing.add("referrer");
    if (d.includes("Missing Permissions-Policy")) missing.add("permissions");
    if (d.includes("HSTS missing includeSubDomains")) missing.add("hsts-subdomains");
  }

  if (missing.size === 0) return [];

  const nextHeaders: string[] = [];
  const vercelHeaders: Array<{ key: string; value: string }> = [];
  const nginxLines: string[] = [];
  const netlifyLines: string[] = [];

  if (missing.has("hsts") || missing.has("hsts-subdomains")) {
    const value = "max-age=63072000; includeSubDomains; preload";
    nextHeaders.push(`{ key: "Strict-Transport-Security", value: "${value}" }`);
    vercelHeaders.push({ key: "Strict-Transport-Security", value });
    nginxLines.push(`add_header Strict-Transport-Security "${value}" always;`);
    netlifyLines.push(`  Strict-Transport-Security: ${value}`);
  }
  if (missing.has("xcontent")) {
    nextHeaders.push(`{ key: "X-Content-Type-Options", value: "nosniff" }`);
    vercelHeaders.push({ key: "X-Content-Type-Options", value: "nosniff" });
    nginxLines.push(`add_header X-Content-Type-Options "nosniff" always;`);
    netlifyLines.push(`  X-Content-Type-Options: nosniff`);
  }
  if (missing.has("xframe")) {
    nextHeaders.push(`{ key: "X-Frame-Options", value: "SAMEORIGIN" }`);
    vercelHeaders.push({ key: "X-Frame-Options", value: "SAMEORIGIN" });
    nginxLines.push(`add_header X-Frame-Options "SAMEORIGIN" always;`);
    netlifyLines.push(`  X-Frame-Options: SAMEORIGIN`);
  }
  if (missing.has("csp")) {
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none';";
    nextHeaders.push(`{ key: "Content-Security-Policy", value: "${csp}" }`);
    vercelHeaders.push({ key: "Content-Security-Policy", value: csp });
    nginxLines.push(`add_header Content-Security-Policy "${csp}" always;`);
    netlifyLines.push(`  Content-Security-Policy: ${csp}`);
  }
  if (missing.has("referrer")) {
    nextHeaders.push(`{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }`);
    vercelHeaders.push({ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" });
    nginxLines.push(`add_header Referrer-Policy "strict-origin-when-cross-origin" always;`);
    netlifyLines.push(`  Referrer-Policy: strict-origin-when-cross-origin`);
  }
  if (missing.has("permissions")) {
    const perms = "camera=(), microphone=(), geolocation=(), interest-cohort=()";
    nextHeaders.push(`{ key: "Permissions-Policy", value: "${perms}" }`);
    vercelHeaders.push({ key: "Permissions-Policy", value: perms });
    nginxLines.push(`add_header Permissions-Policy "${perms}" always;`);
    netlifyLines.push(`  Permissions-Policy: ${perms}`);
  }

  const fixes: FixSnippet[] = [];

  fixes.push({
    platform: "Next.js (next.config.ts)",
    title: "Add to next.config.ts headers() function",
    code: `async headers() {
  return [
    {
      source: "/:path*",
      headers: [
${nextHeaders.map(h => "        " + h + ",").join("\n")}
      ],
    },
  ];
},`,
    instructions: "Add this headers() function inside your nextConfig object, then redeploy.",
  });

  fixes.push({
    platform: "Vercel (vercel.json)",
    title: "Add to vercel.json",
    code: JSON.stringify({
      headers: [{
        source: "/(.*)",
        headers: vercelHeaders,
      }],
    }, null, 2),
    instructions: "Add this to vercel.json in your project root, commit, and redeploy.",
  });

  fixes.push({
    platform: "Nginx",
    title: "Add to your nginx server block",
    code: nginxLines.join("\n"),
    instructions: "Add these lines inside your server { } block, then run: sudo nginx -t && sudo systemctl reload nginx",
  });

  fixes.push({
    platform: "Netlify (_headers file)",
    title: "Create/update public/_headers",
    code: `/*\n${netlifyLines.join("\n")}`,
    instructions: "Create a file at public/_headers (or your publish directory) with this content.",
  });

  return fixes;
}

function generateDnsFixes(details: string[], hostname: string): FixSnippet[] {
  const fixes: FixSnippet[] = [];

  if (details.some(d => d.includes("No SPF"))) {
    fixes.push({
      platform: "DNS (SPF)",
      title: `Add TXT record for ${hostname}`,
      code: `Type:  TXT\nHost:  @ (or ${hostname})\nValue: "v=spf1 -all"\nTTL:   3600`,
      instructions: "Add this TXT record to your DNS. 'v=spf1 -all' rejects all email forgeries (use if you don't send email from this domain). If you DO send email, replace -all with include:yourprovider.com -all.",
    });
  }

  if (details.some(d => d.includes("No DMARC"))) {
    fixes.push({
      platform: "DNS (DMARC)",
      title: `Add TXT record for _dmarc.${hostname}`,
      code: `Type:  TXT\nHost:  _dmarc (or _dmarc.${hostname})\nValue: "v=DMARC1; p=reject; rua=mailto:dmarc@${hostname}"\nTTL:   3600`,
      instructions: "Add this TXT record at the _dmarc subdomain. This rejects all unauthenticated email claiming to be from your domain.",
    });
  }

  return fixes;
}

function generatePerformanceFixes(details: string[]): FixSnippet[] {
  const fixes: FixSnippet[] = [];

  if (details.some(d => d.includes("No compression"))) {
    fixes.push({
      platform: "Nginx (gzip)",
      title: "Enable gzip compression",
      code: `gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_proxied any;
gzip_comp_level 6;
gzip_types text/plain text/css text/xml text/javascript
           application/x-javascript application/javascript
           application/json application/xml+rss
           application/atom+xml image/svg+xml;`,
      instructions: "Add to your nginx.conf http { } block, then run: sudo nginx -t && sudo systemctl reload nginx",
    });

    fixes.push({
      platform: "Vercel / Next.js",
      title: "Already handled automatically",
      code: "// Vercel enables gzip + brotli automatically for all responses.\n// If you're seeing 'No compression' on Vercel, check your next.config headers() isn't overriding Content-Encoding.",
      instructions: "No action needed on Vercel. If deployed and still missing, this is a Vercel-side issue to report.",
    });

    fixes.push({
      platform: "Apache (mod_deflate)",
      title: "Enable compression in .htaccess",
      code: `<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/xml text/css
  AddOutputFilterByType DEFLATE application/javascript application/json
  AddOutputFilterByType DEFLATE image/svg+xml
</IfModule>`,
      instructions: "Add to your .htaccess or Apache config. Ensure mod_deflate is enabled: sudo a2enmod deflate",
    });
  }

  if (details.some(d => d.includes("TTFB"))) {
    fixes.push({
      platform: "Server-side optimization",
      title: "TTFB optimization checklist",
      code: `# TTFB > 800ms means your server is slow to start responding.
# Common causes and fixes:

1. Cold starts (serverless)
   → Use Edge runtime where possible (Next.js: export const runtime = 'edge')
   → Keep functions warm with a cron ping every 5 min

2. Slow database queries
   → Add indexes on frequently queried columns
   → Use a connection pool (don't create new DB connections per request)
   → Cache read-heavy queries (Redis, Vercel KV)

3. Unoptimized rendering
   → Convert to Static Generation (getStaticProps / generateStaticParams)
   → Use ISR with revalidate for semi-static content

4. Geographic distance
   → Use a CDN in front of your origin
   → Deploy to multiple regions`,
      instructions: "These are systemic optimizations, not config snippets. Review each area.",
    });
  }

  return fixes;
}

function generateAvailabilityFixes(details: string[], hostname: string): FixSnippet[] {
  const fixes: FixSnippet[] = [];

  if (details.some(d => d.includes("HTTP does not redirect to HTTPS"))) {
    fixes.push({
      platform: "Nginx",
      title: "Force HTTPS redirect",
      code: `server {
    listen 80;
    server_name ${hostname};
    return 301 https://$host$request_uri;
}`,
      instructions: "Add this server block to your nginx config. All HTTP traffic will 301 to HTTPS.",
    });

    fixes.push({
      platform: "Apache (.htaccess)",
      title: "Force HTTPS redirect",
      code: `RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]`,
      instructions: "Add to your .htaccess file.",
    });
  }

  return fixes;
}

/**
 * Phase 3.1 — minimal Claude wrapper for the Nuclear diagnoser path.
 * Inline rather than imported because this route was previously
 * synchronous-template-only. Mirrors the retry behaviour of
 * /api/scan/fix's anthropicCallWithRetry (jittered exp backoff,
 * 6 attempts) without duplicating the full helper.
 */
async function askClaudeForDiagnosis(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const doCall = () => new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error("Anthropic request timed out")); });
    req.write(body);
    req.end();
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500)));
    }
    try {
      const res = await doCall();
      if (res.status === 200) {
        const content = res.data.content as Array<{ type: string; text: string }>;
        return content?.[0]?.text || "";
      }
      // Non-200 with non-retryable status — bail
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
      }
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
  throw new Error("Anthropic API unreachable after retries");
}

export async function POST(req: NextRequest) {
  let body: {
    hostname?: string;
    modules?: ModResult[];
    tier?: string;
    scanContext?: { platform?: string; stack?: string[] };
    scanStats?: { modulesPassed?: number; modulesTotal?: number; errors?: number; warnings?: number; checksPerformed?: number; durationMs?: number };
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const hostname = body.hostname || "your-domain.com";
  const modules = body.modules || [];

  // Phase 3.1 — Nuclear-tier diagnosis branch. When the caller's tier
  // is `nuclear`, replace category-matched shell templates with
  // Claude-driven evidence-tied diagnosis. The Quick / Full flows
  // continue to use the legacy template generators below — they ship
  // free with those tiers and their snippets are useful starting
  // points for non-Nuclear customers.
  if (body.tier === "nuclear" && ANTHROPIC_API_KEY) {
    const findings: Array<{ detail: string; module: string; severity: string }> = [];
    for (const mod of modules) {
      if (mod.status === "passed") continue;
      for (const detail of (mod.details || [])) {
        findings.push({ detail, module: mod.name, severity: mod.status });
      }
    }
    if (findings.length === 0) {
      return NextResponse.json({
        hostname,
        tier: "nuclear",
        categories: 0,
        totalFixes: 0,
        diagnoses: [],
        summary: "Nuclear diagnoser: 0 findings (all modules passed)",
        report: "## GateTest Nuclear Diagnosis Report\n\nNo error or warning findings to diagnose. All scanned modules passed.",
      });
    }
    try {
      // Run diagnosis + correlation in parallel — independent calls.
      const [diagResult, corrResult] = await Promise.all([
        diagnoseFindings({
          findings,
          hostname,
          scanContext: body.scanContext,
          askClaudeForDiagnosis,
        }),
        correlateFindings({
          findings,
          hostname,
          askClaudeForCorrelation: askClaudeForDiagnosis, // same Claude wrapper, different prompt
        }),
      ]);
      // Executive summary depends on diagnoses + chains, so it runs
      // sequentially. Failures non-blocking — we still return the
      // technical sections.
      let execResult: Awaited<ReturnType<typeof composeExecutiveSummary>> | null = null;
      try {
        execResult = await composeExecutiveSummary({
          scanStats: body.scanStats,
          topFindings: findings.slice(0, 10),
          chains: corrResult.chains,
          hostname,
          askClaudeForSummary: askClaudeForDiagnosis,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "executive summary failed";
        execResult = { ok: false, sections: null, reason: message };
      }
      const execMarkdown = renderExecutiveSummary(execResult, { hostname });
      return NextResponse.json({
        hostname,
        tier: "nuclear",
        totalFindings: findings.length,
        diagnosed: diagResult.diagnoses.filter((d) => d.ok).length,
        skipped: diagResult.diagnoses.filter((d) => !d.ok).length,
        chainsIdentified: corrResult.chains.length,
        executiveSummary: execResult?.ok ? execResult.sections : null,
        summary: `${diagResult.summary} · ${corrResult.summary}${execResult?.ok ? ' · executive summary generated' : ''}`,
        diagnoses: diagResult.diagnoses,
        chains: corrResult.chains,
        // Order matters: executive first (CTO read), then technical detail.
        report: execMarkdown
          + "\n\n"
          + renderDiagnosesReport(diagResult.diagnoses, diagResult.summary)
          + "\n\n"
          + renderCorrelationReport(corrResult),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "diagnosis failed";
      return NextResponse.json({
        error: `Nuclear diagnosis failed: ${message}`,
        hostname,
        tier: "nuclear",
      }, { status: 500 });
    }
  }

  // Quick / Full tier path — legacy templates. Kept because they're
  // useful free starter snippets at lower tiers; the dishonest
  // pattern only existed at Nuclear, which now branches above.
  const allFixes: Record<string, FixSnippet[]> = {};

  for (const mod of modules) {
    const details = mod.details || [];
    if (mod.status === "passed") continue;

    if (mod.name === "headers") {
      const headerFixes = generateHeaderFixes(details);
      if (headerFixes.length > 0) allFixes["Security Headers"] = headerFixes;
    } else if (mod.name === "dns") {
      const dnsFixes = generateDnsFixes(details, hostname);
      if (dnsFixes.length > 0) allFixes["DNS / Email Security"] = dnsFixes;
    } else if (mod.name === "performance") {
      const perfFixes = generatePerformanceFixes(details);
      if (perfFixes.length > 0) allFixes["Performance"] = perfFixes;
    } else if (mod.name === "availability") {
      const availFixes = generateAvailabilityFixes(details, hostname);
      if (availFixes.length > 0) allFixes["Availability"] = availFixes;
    } else if (mod.name === "ssl") {
      allFixes["SSL / TLS"] = [{
        platform: "Let's Encrypt (certbot)",
        title: "Install/renew SSL certificate",
        code: `sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d ${hostname} -d www.${hostname}
sudo systemctl enable certbot.timer`,
        instructions: "Free SSL via Let's Encrypt. Auto-renews every 90 days. Requires nginx to already be running.",
      }];
    }
  }

  return NextResponse.json({
    hostname,
    categories: Object.keys(allFixes).length,
    totalFixes: Object.values(allFixes).reduce((s, f) => s + f.length, 0),
    fixes: allFixes,
  });
}
