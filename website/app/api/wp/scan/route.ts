/**
 * WordPress site scan endpoint.
 *
 * Customer pastes a URL on /wp; this endpoint runs the WP-flavoured
 * module suite against that URL (HTTP probes, no auth required) and
 * returns a plain-language report.
 *
 * Flow:
 *   1. Validate the URL (must be http/https, reachable, looks like a website)
 *   2. Build a "wp-scan" tier context — sets targetUrl in the config so the
 *      WP-specific modules know what to probe
 *   3. Run the suite via the CLI engine runner (closes the 91-vs-22 gap)
 *   4. Translate findings into plain-language WP-owner copy
 *   5. Return JSON suitable for the /wp landing page to render
 *
 * Free preview behaviour: by default returns only the top 3 highest-severity
 * findings, plus a `paywall: { remainingCount }` field. The full report
 * lands once payment is captured (Stripe wire-up follows).
 *
 * No authentication. No git access. Just a URL → report.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // WP scans are HTTP-probe-bound; 60s is plenty

interface WpScanRequest {
  url?: string;
  fullReport?: boolean; // true once payment captured; defaults to preview
}

interface WpFinding {
  severity: "error" | "warning" | "info";
  title: string;
  body: string;
  module: string;
  ruleKey: string;
}

function parseUrl(input: string): URL | null {
  if (!input || typeof input !== "string") return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    // Block private / loopback addresses — protects us from being abused
    // as a port scanner against internal infrastructure.
    if (
      u.hostname === "localhost" ||
      u.hostname.startsWith("127.") ||
      u.hostname.startsWith("10.") ||
      u.hostname.startsWith("192.168.") ||
      u.hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(u.hostname)
    ) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

/**
 * Translate a raw module-finding message into customer-facing copy.
 * Maps module rule keys to plain-English title + body. Falls back to
 * the raw message if no mapping exists (so new modules surface
 * something rather than silently dropping their findings).
 */
function translateFinding(check: {
  name: string;
  severity?: string;
  message?: string;
}): WpFinding | null {
  const sev = (check.severity || "info").toLowerCase();
  if (sev !== "error" && sev !== "warning" && sev !== "info") return null;
  if (sev === "info" || check.message?.startsWith("wp-exposed-files: probed")) {
    // Drop module-summary chatter from the customer report
    return null;
  }

  // Module-prefix-based titling — keeps WP findings clear of the generic
  // module noise.
  const name = check.name;
  let title = check.message || name;
  let body = check.message || "";
  let module = "general";

  if (name.startsWith("wp-exposed-files:found:")) {
    const file = name.replace("wp-exposed-files:found:", "");
    module = "wpExposedFiles";
    title = `Sensitive file exposed: ${file}`;
    body =
      `Anyone on the internet can read \`${file}\` by visiting it directly. ` +
      `Most attackers scan for these specific files within minutes of a new domain going live.` +
      `\n\nWhat to do: log in to your hosting control panel (cPanel / Plesk / SSH) and delete the file. ` +
      `If it's needed for development, move it OUTSIDE the public webroot.`;
  } else if (name.startsWith("wp-version-leak:")) {
    module = "wpVersionLeak";
    title = "WordPress version is publicly visible";
    body =
      (check.message || "") +
      `\n\nWhy this matters: when an attacker knows your exact WordPress version, ` +
      `they can match it against the public CVE database and find known exploits in minutes. ` +
      `Hiding the version doesn't fix the underlying CVE, but it does mean you're not the easy target.`;
  } else if (name === "wp-xmlrpc:pingback-available") {
    module = "wpXmlrpcExposed";
    title = "Your site can be used as a DDoS weapon";
    body =
      (check.message || "") +
      `\n\nThis is the worst-case xmlrpc.php configuration: pingback.ping is enabled, ` +
      `which lets a third party tell your server to make HTTP requests to ANY other site. ` +
      `Attackers chain dozens of WordPress sites with this flaw to overwhelm a single target.`;
  } else if (name === "wp-xmlrpc:exposed") {
    module = "wpXmlrpcExposed";
    title = "XML-RPC is enabled (legacy login interface)";
    body = check.message || "";
  } else if (name.startsWith("web-headers:")) {
    module = "webHeaders";
    title = "Missing security header";
    body =
      (check.message || "") +
      `\n\nFix: add the header in your nginx config, .htaccess, or via a security plugin (e.g. Really Simple SSL).`;
  } else if (name.startsWith("tls-")) {
    module = "tlsSecurity";
    title = "HTTPS / TLS misconfiguration";
    body = check.message || "";
  } else if (name.startsWith("cookie-")) {
    module = "cookieSecurity";
    title = "Cookie hardening missing";
    body = check.message || "";
  } else if (name.startsWith("accessibility:") || name.includes("a11y")) {
    module = "accessibility";
    title = "Accessibility issue";
    body = check.message || "";
  } else if (name.startsWith("seo:")) {
    module = "seo";
    title = "SEO issue";
    body = check.message || "";
  } else if (name.startsWith("links:") || name.startsWith("broken-link")) {
    module = "links";
    title = "Broken link / image";
    body = check.message || "";
  } else if (name.startsWith("performance:")) {
    module = "performance";
    title = "Performance issue";
    body = check.message || "";
  } else {
    // Unmapped finding — surface raw but lightly cleaned
    title = (check.message || name).split(":").slice(0, 2).join(":");
    body = check.message || `Raw finding key: ${name}`;
  }

  return {
    severity: sev as "error" | "warning" | "info",
    title,
    body,
    module,
    ruleKey: name,
  };
}

export async function POST(req: NextRequest) {
  // Support both JSON body (XHR from React) and form submission (the
  // landing page's <form action="/api/wp/scan" method="POST">).
  let url: string | undefined;
  let fullReport = false;

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    let body: WpScanRequest;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    url = body.url;
    fullReport = Boolean(body.fullReport);
  } else {
    const form = await req.formData();
    url = String(form.get("url") || "");
  }

  const parsed = parseUrl(url || "");
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          "Please paste a valid public WordPress site URL (e.g. https://yoursite.com). " +
          "Localhost and internal addresses are blocked.",
      },
      { status: 400 }
    );
  }

  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // WP scans probe a live URL — no fileContents needed. We invoke the
  // CLI engine directly here (rather than going through cli-engine-runner)
  // so we can inject targetUrl into the runtime config that the WP
  // modules read. cli-engine-runner doesn't yet support a config-override
  // shape; can be unified once we have a clear pattern across both flows.
  //
  // turbopackIgnore: the CLI engine eventually loads src/core/registry.js
  // which does dynamic require()s of every module file. Turbopack tries
  // to enumerate all possible targets at build time and crashes. The
  // comment tells Turbopack to skip tracing through this boundary;
  // Node-at-runtime resolves normally.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GateTest } = require(/* turbopackIgnore: true */ "../../../../../src/index.js") as {
    GateTest: new (root: string, opts?: Record<string, unknown>) => {
      init: () => { runSuite: (name: string) => Promise<unknown> };
      registry: { list: () => string[] };
      config: { set?: (key: string, value: unknown) => void; data?: Record<string, unknown> };
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require("path") as typeof import("path");

  const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "wp-scan-"));
  const startTime = Date.now();

  // Pre-empt the engine setting process.exitCode = 1 if any module fails.
  const previousExitCode = process.exitCode;

  let summary: { results?: Array<{ module?: string; name?: string; checks?: Array<{ name: string; severity?: string; passed: boolean; message?: string }>; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string }>; gateStatus?: string; totalErrors?: number; totalWarnings?: number };

  try {
    const gt = new GateTest(workspace, { silent: true });
    gt.init();
    // Inject the target URL into the runtime config the WP modules read.
    // The CLI's GateTestConfig has a `data` object that modules pull from.
    if (gt.config && typeof gt.config === "object") {
      // Different config implementations expose data differently; try both.
      if (typeof (gt.config as { set?: (k: string, v: unknown) => void }).set === "function") {
        (gt.config as { set: (k: string, v: unknown) => void }).set("targetUrl", targetUrl);
        (gt.config as { set: (k: string, v: unknown) => void }).set("wpUrl", targetUrl);
      } else if ((gt.config as { data?: Record<string, unknown> }).data) {
        (gt.config as { data: Record<string, unknown> }).data.targetUrl = targetUrl;
        (gt.config as { data: Record<string, unknown> }).data.wpUrl = targetUrl;
      }
    }
    summary = (await gt.init().runSuite("wp")) as typeof summary;
  } catch (err) {
    process.exitCode = previousExitCode;
    // Best-effort cleanup
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : "Unexpected scan failure";
    return NextResponse.json(
      { error: `Scan failed: ${msg}. Please try again or contact support.` },
      { status: 500 }
    );
  } finally {
    process.exitCode = previousExitCode;
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Flatten findings, translate to plain-language
  const allFindings: WpFinding[] = [];
  for (const r of summary.results || []) {
    if (!Array.isArray(r.checks)) continue;
    for (const c of r.checks) {
      if (c.passed === true) continue; // skip passing checks
      const translated = translateFinding(c);
      if (translated) allFindings.push(translated);
    }
  }

  // Sort by severity (error > warning > info), then by module
  const SEV_ORDER = { error: 0, warning: 1, info: 2 };
  allFindings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.module.localeCompare(b.module));

  const PREVIEW_LIMIT = 3;
  const isPreview = !fullReport;
  const findings = isPreview ? allFindings.slice(0, PREVIEW_LIMIT) : allFindings;

  return NextResponse.json({
    targetUrl,
    scannedAt: new Date().toISOString(),
    duration: Date.now() - startTime,
    totalFindings: allFindings.length,
    errorCount: allFindings.filter((f) => f.severity === "error").length,
    warningCount: allFindings.filter((f) => f.severity === "warning").length,
    infoCount: allFindings.filter((f) => f.severity === "info").length,
    preview: isPreview,
    findings,
    paywall: isPreview
      ? {
          remainingCount: Math.max(0, allFindings.length - findings.length),
          fullReportPriceUsd: 19,
          fullReportCadence: "one-shot",
          ctaUrl: "/api/checkout?tier=wp_health",
        }
      : null,
  });
}

export async function GET() {
  return NextResponse.json(
    {
      hint: "POST a JSON body { url: 'https://yoursite.com' } or submit the /wp landing form.",
    },
    { status: 405 }
  );
}
