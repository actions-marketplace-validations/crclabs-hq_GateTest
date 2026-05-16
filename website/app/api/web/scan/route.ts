/**
 * Generic web URL scan endpoint.
 *
 * Twin of /api/wp/scan but for any public web URL — not just WordPress.
 * Runs the `web` suite (static probes + runtime browser checks):
 *
 *   - web-headers       CSP, HSTS, XFO, nosniff, Permissions-Policy
 *   - tls-security      HTTPS, cert chain, modern protocol support
 *   - cookie-security   Secure, HttpOnly, SameSite flags
 *   - accessibility     ARIA, alt text, contrast (where probe-able)
 *   - seo               meta, canonical, structured data
 *   - links             broken-link surface check
 *   - performance       basic timing metrics
 *   - runtimeErrors     headless-browser-driven LIVE error capture —
 *                       page errors, console.error spam, CSP violations,
 *                       hydration mismatches, mixed content, network
 *                       failures. The "real conflict" findings that
 *                       static probing can't see.
 *
 * Free preview returns the top 3 highest-signal clusters plus a
 * health-score verdict (0-100). Full report unlocks once payment is
 * captured.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface WebScanRequest {
  url?: string;
  fullReport?: boolean;
}

interface WebFinding {
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
 * Translate a raw check into a customer-facing finding. Reuses the same
 * pattern as /api/wp/scan but with generic web copy — no WordPress-isms.
 */
function translateFinding(check: {
  name: string;
  severity?: string;
  message?: string;
}): WebFinding | null {
  const sev = (check.severity || "info").toLowerCase();
  if (sev !== "error" && sev !== "warning" && sev !== "info") return null;
  if (sev === "info") return null; // summaries / config notes are not customer-facing

  const name = check.name;
  let title = check.message || name;
  let body = check.message || "";
  let module = "general";

  if (name.startsWith("web-headers:")) {
    module = "webHeaders";
    title = "Missing or weak security header";
    body =
      (check.message || "") +
      `\n\nFix: add the header in your reverse proxy (nginx, Caddy, Apache), CDN (Cloudflare, Fastly), or app server (Next.js headers(), Express helmet middleware).`;
  } else if (name.startsWith("tls-")) {
    module = "tlsSecurity";
    title = "HTTPS / TLS issue";
    body = check.message || "";
  } else if (name.startsWith("cookie-")) {
    module = "cookieSecurity";
    title = "Cookie hardening missing";
    body = check.message || "";
  } else if (name.startsWith("runtime-errors:page-error") || name.startsWith("runtime-errors:initial-status")) {
    module = "runtimeErrors";
    title = "JavaScript error on page load";
    body =
      (check.message || "") +
      `\n\nWhy it matters: uncaught JS errors break interactive features (forms, navigation, search). Real visitors see a blank or partially-loaded page.`;
  } else if (name.startsWith("runtime-errors:console-error")) {
    module = "runtimeErrors";
    title = "Console error during load";
    body = check.message || "";
  } else if (name.startsWith("runtime-errors:network")) {
    module = "runtimeErrors";
    title = "Network resource failed to load";
    body =
      (check.message || "") +
      `\n\nFailed assets (scripts, images, fonts) often mean broken features and a degraded experience.`;
  } else if (name.startsWith("runtime-errors:csp-violation")) {
    module = "runtimeErrors";
    title = "Content Security Policy violation";
    body =
      (check.message || "") +
      `\n\nA real browser blocked something the page tried to do. Often this means a third-party script or analytics tag is broken — or your CSP is too strict for your own code.`;
  } else if (name.startsWith("runtime-errors:mixed-content")) {
    module = "runtimeErrors";
    title = "Mixed content blocked";
    body =
      (check.message || "") +
      `\n\nYour HTTPS page tried to load HTTP assets — modern browsers refuse to load them. Convert all asset URLs to https://.`;
  } else if (name.startsWith("runtime-errors:hydration")) {
    module = "runtimeErrors";
    title = "Hydration mismatch (React/Vue/Next.js)";
    body =
      (check.message || "") +
      `\n\nServer-rendered HTML did not match the client React tree on first paint. Users see flicker, blank content, or interactive elements that don't respond until the page re-renders.`;
  } else if (name.startsWith("runtime-errors:navigation")) {
    module = "runtimeErrors";
    title = "Page failed to load in a real browser";
    body =
      (check.message || "") +
      `\n\nA headless Chromium instance could not reach this page. If a scanner can't load it, real visitors will hit the same wall.`;
  } else if (name === "crawl:broken-links" || name === "crawl:broken-images") {
    module = "liveCrawler";
    title = name === "crawl:broken-images" ? "Broken image(s) on your site" : "Broken link(s) on your site";
    body =
      (check.message || "") +
      `\n\nVisitors clicking these get a 404 — bad for conversion and SEO.`;
  } else if (name === "crawl:broken-scripts") {
    module = "liveCrawler";
    title = "Broken JavaScript bundle";
    body =
      (check.message || "") +
      `\n\nWhen a JS file 404s, the features depending on it silently break. Users may not even see an error — they just won't be able to use search, forms, or interactive elements.`;
  } else if (name === "crawl:broken-stylesheets") {
    module = "liveCrawler";
    title = "Broken stylesheet";
    body =
      (check.message || "") +
      `\n\nVisitors see raw HTML with no styling for the few seconds before the page falls back, or permanently if the file never loads.`;
  } else if (name === "crawl:missing-meta-description") {
    module = "liveCrawler";
    title = "Pages missing meta description";
    body =
      (check.message || "") +
      `\n\nGoogle's snippet text uses your meta description. Without one, Google guesses — usually poorly. Click-through rate suffers.`;
  } else if (name === "crawl:missing-canonical") {
    module = "liveCrawler";
    title = "Pages missing canonical link";
    body =
      (check.message || "") +
      `\n\nWithout a canonical, multiple URLs (with/without trailing slash, with/without query strings) can be indexed as separate pages — diluting SEO authority.`;
  } else if (name === "crawl:slow-pages") {
    module = "liveCrawler";
    title = "Slow-loading pages";
    body =
      (check.message || "") +
      `\n\nReal users bounce when TTFB exceeds ~2.5 seconds. Each second past that costs measurable revenue.`;
  } else if (name === "crawl:anchor-missing-target") {
    module = "liveCrawler";
    title = "Anchor links pointing at non-existent targets";
    body =
      (check.message || "") +
      `\n\nA visitor clicks the link and nothing happens. Either remove the anchor or add the id to the target element.`;
  } else if (name === "crawl:duplicate-titles") {
    module = "liveCrawler";
    title = "Duplicate page titles";
    body =
      (check.message || "") +
      `\n\nMultiple pages share a <title>. Browser tabs become indistinguishable and Google de-prioritises duplicated content.`;
  } else if (name === "crawl:sitemap-missing") {
    module = "liveCrawler";
    title = "No sitemap.xml found";
    body = check.message || "";
  } else if (name === "crawl:robots-missing") {
    module = "liveCrawler";
    title = "No robots.txt found";
    body = check.message || "";
  } else if (name === "crawl:favicon-missing") {
    module = "liveCrawler";
    title = "No favicon found";
    body = check.message || "";
  } else if (name.startsWith("crawl:error:")) {
    module = "liveCrawler";
    const errType = name.replace("crawl:error:", "");
    title = `Site issue detected: ${errType.replace(/-/g, " ")}`;
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
    title = "Broken link or image";
    body = check.message || "";
  } else if (name.startsWith("performance:")) {
    module = "performance";
    title = "Performance issue";
    body = check.message || "";
  } else {
    title = (check.message || name).split(":").slice(0, 2).join(":");
    body = check.message || `Raw finding: ${name}`;
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
  let url: string | undefined;
  let fullReport = false;

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    let body: WebScanRequest;
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
          "Please paste a valid public website URL (e.g. https://yoursite.com). " +
          "Localhost and internal addresses are blocked.",
      },
      { status: 400 }
    );
  }

  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // turbopackIgnore: the CLI engine eventually loads src/core/registry.js
  // which does dynamic require()s of every module file. Turbopack tries
  // to enumerate all possible targets at build time and crashes.
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

  const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "web-scan-"));
  const startTime = Date.now();
  const previousExitCode = process.exitCode;
  // Stable per-scan id used to link the static probe results with the
  // runtime payload that Crontech will POST back to us.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cryptoMod = require("crypto") as typeof import("crypto");
  const scanId = `scn_${cryptoMod.randomBytes(9).toString("hex")}`;

  let summary: { results?: Array<{ module?: string; name?: string; checks?: Array<{ name: string; severity?: string; passed: boolean; message?: string }>; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string }>; gateStatus?: string; totalErrors?: number; totalWarnings?: number };

  try {
    const gt = new GateTest(workspace, { silent: true });
    gt.init();
    if (gt.config && typeof gt.config === "object") {
      if (typeof (gt.config as { set?: (k: string, v: unknown) => void }).set === "function") {
        (gt.config as { set: (k: string, v: unknown) => void }).set("targetUrl", targetUrl);
        (gt.config as { set: (k: string, v: unknown) => void }).set("webUrl", targetUrl);
      } else if ((gt.config as { data?: Record<string, unknown> }).data) {
        (gt.config as { data: Record<string, unknown> }).data.targetUrl = targetUrl;
        (gt.config as { data: Record<string, unknown> }).data.webUrl = targetUrl;
      }
    }
    summary = (await gt.init().runSuite("web")) as typeof summary;
  } catch (err) {
    process.exitCode = previousExitCode;
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

  const allFindings: WebFinding[] = [];
  for (const r of summary.results || []) {
    if (!Array.isArray(r.checks)) continue;
    for (const c of r.checks) {
      if (c.passed === true) continue;
      const translated = translateFinding(c);
      if (translated) allFindings.push(translated);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clusterAndRankUrlFindings } = require("@/app/lib/url-finding-clusterer") as {
    clusterAndRankUrlFindings: (
      findings: WebFinding[],
      opts?: { includeInfo?: boolean }
    ) => {
      clusters: Array<{ ruleKey: string; severity: 'error' | 'warning' | 'info'; title: string; body: string; module: string; count: number; instances: WebFinding[]; isHighSignal: boolean }>;
      totalIn: number;
      totalInstances: number;
      droppedInfo: number;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeHealthScore } = require("@/app/lib/health-score") as {
    computeHealthScore: (clusters: Array<{ severity: string; isHighSignal: boolean; count: number; ruleKey?: string }>) => {
      score: number;
      grade: 'A' | 'B' | 'C' | 'D' | 'F';
      deductions: Array<unknown>;
      summary: string;
    };
  };

  const clusterResult = clusterAndRankUrlFindings(allFindings);
  const healthScore = computeHealthScore(clusterResult.clusters);

  const PREVIEW_LIMIT = 3;
  const isPreview = !fullReport;
  const visibleClusters = isPreview ? clusterResult.clusters.slice(0, PREVIEW_LIMIT) : clusterResult.clusters;
  const findings = visibleClusters.map((c) => ({
    severity: c.severity,
    title: c.title,
    body: c.body,
    module: c.module,
    ruleKey: c.ruleKey,
    instanceCount: c.count,
    highSignal: c.isHighSignal,
  }));

  // Dispatch the headless-browser runtime scan to Crontech (worker tier).
  // Static probes already ran inline on this serverless function. The
  // runtime checks (live JS errors, hydration mismatches, CSP violations,
  // network failures) need a long-running container with Chromium —
  // that's Crontech's job. Best effort: if dispatch fails we still ship
  // the static-probe results below.
  let runtimeStatus: "queued" | "unavailable" = "unavailable";
  let runtimeJobId: string | null = null;
  let runtimeReason: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dispatchRuntimeScan } = require("@/app/lib/crontech-dispatch") as {
      dispatchRuntimeScan: (opts: {
        scanId: string;
        targetUrl: string;
        suite: string;
        callbackUrl: string;
        deadlineSec?: number;
      }) => Promise<{ ok: true; jobId: string; queuedAt: string } | { ok: false; reason: string; status?: number }>;
    };
    const callbackBase = process.env.GATETEST_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
    if (callbackBase) {
      const result = await dispatchRuntimeScan({
        scanId,
        targetUrl,
        suite: "web",
        callbackUrl: `${callbackBase.replace(/\/$/, "")}/api/web/scan/runtime-callback`,
        deadlineSec: 60,
      });
      if (result.ok) {
        runtimeStatus = "queued";
        runtimeJobId = result.jobId;
      } else {
        runtimeReason = result.reason;
      }
    } else {
      runtimeReason = "GATETEST_PUBLIC_BASE_URL not configured";
    }
  } catch (err) {
    runtimeReason = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    scanId,
    targetUrl,
    scannedAt: new Date().toISOString(),
    duration: Date.now() - startTime,
    healthScore: {
      score: healthScore.score,
      grade: healthScore.grade,
      summary: healthScore.summary,
    },
    totalFindings: allFindings.length,
    totalClusters: clusterResult.clusters.length,
    errorCount: clusterResult.clusters.filter((c) => c.severity === "error").length,
    warningCount: clusterResult.clusters.filter((c) => c.severity === "warning").length,
    infoCount: clusterResult.droppedInfo,
    preview: isPreview,
    findings,
    runtime: {
      status: runtimeStatus,
      jobId: runtimeJobId,
      reason: runtimeReason,
      pollUrl: runtimeStatus === "queued" ? `/api/web/scan/runtime-status?scanId=${scanId}` : null,
    },
    paywall: isPreview
      ? {
          remainingCount: Math.max(0, clusterResult.clusters.length - findings.length),
          fullReportPriceUsd: 29,
          fullReportCadence: "one-shot",
          ctaUrl: "/api/checkout?tier=quick",
        }
      : null,
  });
}

export async function GET() {
  return NextResponse.json(
    {
      hint: "POST a JSON body { url: 'https://yoursite.com' } or submit the /web landing form.",
    },
    { status: 405 }
  );
}
