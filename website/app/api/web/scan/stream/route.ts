/**
 * Streaming web URL scan endpoint.
 *
 * Returns Server-Sent Events (text/event-stream) so the customer's UI
 * sees each module tick through in real time — not a fake progress
 * animation. The final `complete` event carries the same payload shape
 * the non-streaming /api/web/scan endpoint returns.
 *
 * Event types:
 *   event: start          { targetUrl, scanId, suite }
 *   event: module:start   { module, name }
 *   event: module:end     { module, name, errors, warnings, info, duration }
 *   event: module:skip    { module, name, reason }
 *   event: complete       <full ScanResult JSON>
 *   event: error          { error }
 *
 * The function also emits keep-alive comment lines (`:\n\n`) every ~10s
 * so the connection doesn't idle out on Vercel's serverless runtime
 * before the scan finishes.
 *
 * Client (UrlScanFlow.tsx) consumes via `fetch().body.getReader()` plus
 * a small SSE-line parser. EventSource isn't usable here because it
 * only does GET, and we need POST with a JSON body.
 */

import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface StreamRequest {
  url?: string;
  fullReport?: boolean;
}

interface RawCheck { name: string; severity?: string; passed: boolean; message?: string }
interface RawResult { module?: string; name?: string; checks?: RawCheck[]; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string }
interface RawSummary { results?: RawResult[]; gateStatus?: string; totalErrors?: number; totalWarnings?: number }

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
    ) return null;
    return u;
  } catch {
    return null;
  }
}

// Translation table — mirrors /api/web/scan/route.ts. Kept local to this
// file to avoid an import cycle; if we end up with a third URL-scan route
// the right move is to extract translateFinding into a shared helper.
function translateFinding(check: { name: string; severity?: string; message?: string }): WebFinding | null {
  const sev = (check.severity || "info").toLowerCase();
  if (sev !== "error" && sev !== "warning" && sev !== "info") return null;
  if (sev === "info") return null;
  const name = check.name;
  let title = check.message || name;
  let body = check.message || "";
  let module = "general";
  if (name.startsWith("web-headers:")) {
    module = "webHeaders"; title = "Missing or weak security header";
    body = (check.message || "") + `\n\nFix: add the header in your reverse proxy, CDN, or app server.`;
  } else if (name.startsWith("tls-")) {
    module = "tlsSecurity"; title = "HTTPS / TLS issue"; body = check.message || "";
  } else if (name.startsWith("cookie-")) {
    module = "cookieSecurity"; title = "Cookie hardening missing"; body = check.message || "";
  } else if (name.startsWith("runtime-errors:page-error") || name.startsWith("runtime-errors:initial-status")) {
    module = "runtimeErrors"; title = "JavaScript error on page load"; body = check.message || "";
  } else if (name.startsWith("runtime-errors:console-error")) {
    module = "runtimeErrors"; title = "Console error during load"; body = check.message || "";
  } else if (name.startsWith("runtime-errors:network")) {
    module = "runtimeErrors"; title = "Network resource failed to load"; body = check.message || "";
  } else if (name === "crawl:broken-links" || name === "crawl:broken-images") {
    module = "liveCrawler";
    title = name === "crawl:broken-images" ? "Broken image(s) on your site" : "Broken link(s) on your site";
    body = (check.message || "") + `\n\nVisitors clicking these get a 404 — bad for conversion and SEO.`;
  } else if (name === "crawl:broken-scripts") {
    module = "liveCrawler"; title = "Broken JavaScript bundle";
    body = (check.message || "") + `\n\nFeatures depending on these scripts will silently break for real users.`;
  } else if (name === "crawl:broken-stylesheets") {
    module = "liveCrawler"; title = "Broken stylesheet";
    body = (check.message || "") + `\n\nVisitors see unstyled HTML.`;
  } else if (name === "crawl:missing-meta-description") {
    module = "liveCrawler"; title = "Pages missing meta description"; body = check.message || "";
  } else if (name === "crawl:missing-canonical") {
    module = "liveCrawler"; title = "Pages missing canonical link"; body = check.message || "";
  } else if (name === "crawl:slow-pages") {
    module = "liveCrawler"; title = "Slow-loading pages"; body = check.message || "";
  } else if (name === "crawl:anchor-missing-target") {
    module = "liveCrawler"; title = "Anchor links pointing at non-existent targets"; body = check.message || "";
  } else if (name === "crawl:duplicate-titles") {
    module = "liveCrawler"; title = "Duplicate page titles"; body = check.message || "";
  } else if (name === "crawl:sitemap-missing") {
    module = "liveCrawler"; title = "No sitemap.xml found"; body = check.message || "";
  } else if (name === "crawl:robots-missing") {
    module = "liveCrawler"; title = "No robots.txt found"; body = check.message || "";
  } else if (name === "crawl:favicon-missing") {
    module = "liveCrawler"; title = "No favicon found"; body = check.message || "";
  } else if (name.startsWith("crawl:error:")) {
    module = "liveCrawler";
    title = `Site issue: ${name.replace("crawl:error:", "").replace(/-/g, " ")}`;
    body = check.message || "";
  } else if (name.startsWith("accessibility:") || name.includes("a11y")) {
    module = "accessibility"; title = "Accessibility issue"; body = check.message || "";
  } else if (name.startsWith("seo:")) {
    module = "seo"; title = "SEO issue"; body = check.message || "";
  } else if (name.startsWith("performance:")) {
    module = "performance"; title = "Performance issue"; body = check.message || "";
  } else {
    title = (check.message || name).split(":").slice(0, 2).join(":");
    body = check.message || `Raw finding: ${name}`;
  }
  return { severity: sev as "error" | "warning" | "info", title, body, module, ruleKey: name };
}

export async function POST(req: NextRequest) {
  let body: StreamRequest;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }
  const fullReport = Boolean(body.fullReport);
  const parsed = parseUrl(body.url || "");
  if (!parsed) {
    return new Response(JSON.stringify({
      error: "Please paste a valid public website URL. Localhost and internal addresses are blocked.",
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cryptoMod = require("crypto") as typeof import("crypto");
  const scanId = `scn_${cryptoMod.randomBytes(9).toString("hex")}`;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* controller closed mid-write */ }
      };
      const keepAliveTimer = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* ignore */ }
      }, 10000);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs") as typeof import("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require("os") as typeof import("os");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require("path") as typeof import("path");
      const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "web-scan-"));
      const previousExitCode = process.exitCode;
      const startTime = Date.now();

      send("start", { scanId, targetUrl, suite: "web" });

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { GateTest } = require(/* turbopackIgnore: true */ "../../../../../../src/index.js") as {
          GateTest: new (root: string, opts?: Record<string, unknown>) => {
            init: () => { runSuite: (name: string) => Promise<unknown> };
            config: { set?: (key: string, value: unknown) => void; data?: Record<string, unknown> };
          };
        };
        // Module-level event forwarding via the new onProgress hook
        const gt = new GateTest(workspace, {
          silent: true,
          onProgress: (event: string, payload: unknown) => {
            // Forward only the lightweight per-module events to the SSE
            // stream. Full suite:end carries the entire summary which we
            // process locally below.
            if (event === "module:start" || event === "module:end" || event === "module:skip") {
              const p = payload as { module?: string; name?: string; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string };
              send(event, {
                module: p.module || p.name || "unknown",
                errors: p.errors,
                warnings: p.warnings,
                info: p.info,
                duration: p.duration,
                skipped: p.skipped,
              });
            }
          },
        });
        gt.init();
        if (gt.config && typeof gt.config === "object") {
          const c = gt.config as { set?: (k: string, v: unknown) => void; data?: Record<string, unknown> };
          if (typeof c.set === "function") {
            c.set("targetUrl", targetUrl);
            c.set("webUrl", targetUrl);
          } else if (c.data) {
            c.data.targetUrl = targetUrl;
            c.data.webUrl = targetUrl;
          }
        }
        const summary = (await gt.init().runSuite("web")) as RawSummary;

        const allFindings: WebFinding[] = [];
        for (const r of summary.results || []) {
          if (!Array.isArray(r.checks)) continue;
          for (const c of r.checks) {
            if (c.passed === true) continue;
            const t = translateFinding(c);
            if (t) allFindings.push(t);
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { clusterAndRankUrlFindings } = require("@/app/lib/url-finding-clusterer") as {
          clusterAndRankUrlFindings: (findings: WebFinding[]) => {
            clusters: Array<{ ruleKey: string; severity: 'error' | 'warning' | 'info'; title: string; body: string; module: string; count: number; isHighSignal: boolean }>;
            totalIn: number;
            totalInstances: number;
            droppedInfo: number;
          };
        };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { computeHealthScore } = require("@/app/lib/health-score") as {
          computeHealthScore: (clusters: Array<{ severity: string; isHighSignal: boolean; count: number; ruleKey?: string }>) => {
            score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; deductions: Array<unknown>; summary: string;
          };
        };

        const clusterResult = clusterAndRankUrlFindings(allFindings);
        const healthScore = computeHealthScore(clusterResult.clusters);

        const PREVIEW_LIMIT = 3;
        const isPreview = !fullReport;
        const visible = isPreview ? clusterResult.clusters.slice(0, PREVIEW_LIMIT) : clusterResult.clusters;
        const findings = visible.map((c) => ({
          severity: c.severity, title: c.title, body: c.body, module: c.module,
          ruleKey: c.ruleKey, instanceCount: c.count, highSignal: c.isHighSignal,
        }));

        send("complete", {
          scanId,
          targetUrl,
          scannedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
          healthScore: { score: healthScore.score, grade: healthScore.grade, summary: healthScore.summary },
          totalFindings: allFindings.length,
          totalClusters: clusterResult.clusters.length,
          errorCount: clusterResult.clusters.filter((c) => c.severity === "error").length,
          warningCount: clusterResult.clusters.filter((c) => c.severity === "warning").length,
          infoCount: clusterResult.droppedInfo,
          preview: isPreview,
          findings,
          runtime: { status: "unavailable" as const, reason: "Runtime worker wiring pending" },
          paywall: isPreview ? {
            remainingCount: Math.max(0, clusterResult.clusters.length - findings.length),
            fullReportPriceUsd: 29, fullReportCadence: "one-shot",
            ctaUrl: "/api/checkout?tier=quick",
          } : null,
        });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "Unexpected scan failure" });
      } finally {
        process.exitCode = previousExitCode;
        try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
        clearInterval(keepAliveTimer);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
