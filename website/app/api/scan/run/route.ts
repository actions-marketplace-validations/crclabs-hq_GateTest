/**
 * Scan Run API — Runs the scan and returns results directly.
 *
 * POST /api/scan/run
 * Body: { sessionId, repoUrl, tier }
 *
 * NO WEBHOOK DEPENDENCY. The client calls this directly after checkout.
 * Returns the scan result in one response. Simple. Fast. Reliable.
 *
 * Also updates Stripe payment intent metadata and captures payment.
 *
 * Honesty contract: every module listed in scan-modules/index.ts does real
 * work. Modules that cannot run return status "skipped" with a reason —
 * never a fake pass.
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { isAdminRequest } from "@/app/lib/admin-auth";
import { fetchBlob, fetchTree, resolveRepoAuth } from "@/app/lib/gluecron-client";
import { runTier, type RepoFile } from "@/app/lib/scan-modules";
// Wire contract reference: Gluecron.com/GATETEST_HOOK.md — each repo keeps its
// own copy per the HTTP-only coupling rule.
import { sendGluecronCallback } from "@/app/lib/gluecron-callback";

// 5-minute function budget — needs Vercel Pro; Hobby cap is 60s.
export const maxDuration = 300;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const MAX_FILES_TO_READ = 50;
// Leave 30s headroom for Stripe metadata writes and response serialisation.
const SCAN_TIME_BUDGET_MS = 260_000;

function stripeApi(
  method: string,
  path: string,
  body?: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "api.stripe.com",
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    if (body) {
      options.headers = {
        ...options.headers,
        "Content-Length": String(Buffer.byteLength(body)),
      };
    }
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

interface ModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

interface ScanRepoResult {
  modules: ModuleResult[];
  totalIssues: number;
  duration: number;
  authSource?: string | null;
  error?: string;
}

async function scanRepo(owner: string, repo: string, tier: string): Promise<ScanRepoResult> {
  const startTime = Date.now();
  const deadline = startTime + SCAN_TIME_BUDGET_MS;

  // Resolve Gluecron auth. Gluecron is PAT-only; resolveRepoAuth pings
  // the repo endpoint to confirm the token has access before we attempt
  // the tree fetch.
  const auth = await resolveRepoAuth(owner, repo);
  const token = auth.token || undefined;

  if (!token) {
    return {
      modules: [],
      totalIssues: 0,
      duration: Date.now() - startTime,
      authSource: auth.source,
      error: `Cannot access ${owner}/${repo}${auth.error ? ` (${auth.error})` : ""}`,
    };
  }

  const files = await fetchTree(owner, repo, "HEAD", token);
  if (files.length === 0) {
    return {
      modules: [],
      totalIssues: 0,
      duration: Date.now() - startTime,
      authSource: auth.source,
      error: `Cannot access ${owner}/${repo} — empty tree`,
    };
  }

  const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".md", ".json", ".yml", ".yaml"];
  const sourceFiles = files.filter(
    (f) => sourceExts.some((ext) => f.endsWith(ext)) &&
      !f.includes("node_modules") && !f.includes(".next") && !f.includes("dist/")
  );

  // Read source files (up to MAX_FILES_TO_READ) in parallel for speed.
  // Bail early if we are already close to the time budget — better to return
  // whatever we have than to let Vercel kill the function mid-response.
  if (Date.now() > deadline) {
    return { modules: [], totalIssues: 0, duration: Date.now() - startTime, authSource: auth.source, error: "scan timed out fetching file tree" };
  }
  const readPromises = sourceFiles.slice(0, MAX_FILES_TO_READ).map(async (filePath): Promise<RepoFile | null> => {
    try {
      const content = await fetchBlob(owner, repo, filePath, "HEAD", token);
      if (content) {
        return { path: filePath, content };
      }
      return null;
    } catch { return null; }
  });
  const fileContents: RepoFile[] = (await Promise.all(readPromises)).filter((f): f is RepoFile => f !== null);

  // Run the tier through the unified module registry — every module does real work.
  // nuclear + scan_fix get their own tier keys (which include mutationAnalysis).
  const scanTier = tier === "nuclear" || tier === "scan_fix" ? tier
    : tier === "full" ? "full" : "quick";
  const { modules, totalIssues } = await runTier(scanTier, {
    owner,
    repo,
    files,
    fileContents,
    token,
    deadlineMs: deadline,
  });

  return {
    modules,
    totalIssues,
    duration: Date.now() - startTime,
    authSource: auth.source,
  };
}

export async function POST(req: NextRequest) {
  let input: {
    sessionId?: string;
    repoUrl?: string;
    tier?: string;
    source?: string;
    sha?: string;
    ref?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { sessionId, repoUrl, tier, source, sha, ref } = input;

  if (!repoUrl) {
    return NextResponse.json({ error: "Missing repo URL" }, { status: 400 });
  }

  // Accept gluecron.com URLs first; fall back to github.com for URLs
  // still in customer bookmarks during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json({ error: "Invalid repo URL (expected gluecron.com/<owner>/<repo>)" }, { status: 400 });
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  // Admin bypass: if the request carries a valid admin cookie, we skip all
  // Stripe interaction entirely. Admin scans never create or capture charges.
  const isAdmin = isAdminRequest(req);

  // ── Idempotency guard ─────────────────────────────────────────────
  // /api/scan/run can be invoked multiple times for the same session
  // (browser refresh, back-button, network retry, client re-render,
  // or a concurrent stripe-webhook after() invocation). Without this
  // check a second call would re-run the scan AND re-capture — in
  // the worst case double-charging or overwriting a valid result.
  // The Stripe metadata's `scan_status` is the canonical replay marker.
  if (!isAdmin && sessionId && STRIPE_SECRET_KEY) {
    try {
      const existing = (await stripeApi(
        "GET",
        `/v1/checkout/sessions/${sessionId}`
      )) as { payment_intent?: string };
      if (existing.payment_intent) {
        const pi = (await stripeApi(
          "GET",
          `/v1/payment_intents/${existing.payment_intent}`
        )) as { metadata?: Record<string, string>; status?: string };
        const prevStatus = pi.metadata?.scan_status;
        if (prevStatus === "complete" || prevStatus === "failed") {
          // Already processed — return the cached state derived from
          // metadata rather than re-running the scan or re-capturing.
          return NextResponse.json({
            status: prevStatus,
            modules: [],
            totalModules: Number(pi.metadata?.total_modules || 0),
            completedModules: Number(pi.metadata?.total_modules || 0),
            totalIssues: Number(pi.metadata?.total_issues || 0),
            totalFixed: 0,
            duration: Number(pi.metadata?.scan_duration || 0),
            repoUrl,
            tier,
            cached: true,
          });
        }
      }
    } catch (err) { // error-ok — idempotency lookup failure must not block the scan
      // Don't block a scan on an idempotency-check lookup failure — log
      // and fall through to the normal scan path.
      console.error("[GateTest] Idempotency check failed:", err);
    }
  }

  // Run the scan
  const result = await scanRepo(owner, repo, tier || "quick");

  // If we have a session ID AND this is NOT an admin request, update Stripe
  // and capture payment. Admins never touch billing.
  if (!isAdmin && sessionId && STRIPE_SECRET_KEY) {
    try {
      const session = (await stripeApi("GET", `/v1/checkout/sessions/${sessionId}`)) as {
        payment_intent?: string;
      };

      if (session.payment_intent) {
        // Store result in Stripe metadata
        const moduleData = result.modules.map((m) =>
          `${m.name}:${m.status}:${m.checks}:${m.issues}:${m.duration}`
        ).join("|");

        const chunks: string[] = [];
        let current = "";
        for (const entry of moduleData.split("|")) {
          if ((current + "|" + entry).length > 490) { chunks.push(current); current = entry; }
          else { current = current ? current + "|" + entry : entry; }
        }
        if (current) chunks.push(current);

        const params = new URLSearchParams({
          "metadata[scan_status]": result.error ? "failed" : "complete",
          "metadata[total_issues]": String(result.totalIssues),
          "metadata[total_modules]": String(result.modules.length),
          "metadata[scan_duration]": String(result.duration),
          "metadata[scan_completed]": new Date().toISOString(),
          "metadata[modules_list]": result.modules.map((m) => m.name).join(","),
        });
        chunks.forEach((chunk, i) => params.set(`metadata[modules_${i}]`, chunk));

        await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}`, params.toString());

        // Capture or cancel payment
        if (!result.error) {
          await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}/capture`);
        } else {
          await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}/cancel`);
        }
      }
    } catch (err) { // error-ok — Stripe metadata update is best-effort; scan result already computed
      console.error("[GateTest] Stripe update failed:", err);
    }
  }

  // Async scan-result callback to Gluecron. Fires only when the inbound
  // request was originated by Gluecron (source === "gluecron") AND both
  // env vars are configured. Failure here MUST NOT break the sync response.
  if (
    source === "gluecron" &&
    process.env.GLUECRON_CALLBACK_URL &&
    process.env.GLUECRON_CALLBACK_SECRET
  ) {
    try {
      await sendGluecronCallback({
        repository: `${owner}/${repo}`,
        sha: sha || "",
        ref,
        scanResult: result,
      });
    } catch (err) { // error-ok — callback failure must not break the synchronous scan response
      console.error("[GateTest] Gluecron callback failed:", err);
    }
  }

  // Build structured fixable-issue list from module details for the Fix Agent.
  const fixableIssues: { file: string; issue: string; module: string }[] = [];
  const FILE_DETAIL = /^([A-Za-z0-9_./@\-+]+?\.[A-Za-z0-9]{1,8})\s*[:—\-]\s*(.+)$/;
  const MISSING_FILE = /^repo:\s*missing\s+(.+)/i;
  for (const mod of result.modules) {
    for (const detail of (mod.details || [])) {
      const stripped = detail.replace(/^(?:error|warn(?:ing)?|info)\s*:\s*/i, "").trim();
      const fileMatch = stripped.match(FILE_DETAIL);
      if (fileMatch) {
        fixableIssues.push({ file: fileMatch[1], issue: fileMatch[2], module: mod.name });
      }
      const missingMatch = stripped.match(MISSING_FILE);
      if (missingMatch) {
        fixableIssues.push({ file: missingMatch[1].trim(), issue: `CREATE_FILE: ${stripped}`, module: mod.name });
      }
    }
  }

  // Phase 5.2.3 — confidence-aware reporting. Adjust per-finding severity
  // based on the brain's per-(module, pattern) confidence scores.
  // Customers never see noise the system has already learned to suppress.
  // Best-effort: brain unavailable → fall through with original modules,
  // never blocks the response.
  let confidenceAdjustments: { suppressedCount: number; downgradedCount: number; perModule: unknown[] } = {
    suppressedCount: 0, downgradedCount: 0, perModule: [],
  };
  let finalModules = result.modules;
  let finalTotalIssues = result.totalIssues;
  try {
     
    const confidenceReport = require("@/app/lib/confidence-aware-report.js");
     
    const moduleConfidence = require("@/app/lib/module-confidence.js");
     
    const { getDb } = require("@/app/lib/db");
    const sqlForConfidence = getDb();
    const resolveAction = confidenceReport.buildResolveAction({
      sql: sqlForConfidence,
      getConfidenceScore: moduleConfidence.getConfidenceScore,
    });
    // The transform is per-module here (no per-finding pattern hash on
    // hand at this layer). resolveAction is async, but the transform
    // function is sync — so resolve actions for all modules first, then
    // pass a sync resolver into applyConfidenceToScan.
    const moduleActionMap = new Map<string, string>();
    for (const m of result.modules) {
      const action = await resolveAction(m.name, null);
      moduleActionMap.set(m.name, action);
    }
    const adjusted = confidenceReport.applyConfidenceToScan(
      { modules: result.modules, totalIssues: result.totalIssues },
      (mod: string) => moduleActionMap.get(mod) || "trust"
    );
    finalModules = adjusted.scanResult.modules;
    finalTotalIssues = adjusted.scanResult.totalIssues;
    confidenceAdjustments = adjusted.adjustments;
  } catch {
    // Brain unavailable — surface unmodified results.
  }

  // For scan-only tiers ($29 quick / $99 full), redact file paths and line
  // numbers from finding detail strings. Customers see WHAT is wrong but
  // not WHERE, preventing copy-paste-into-Claude to bypass the fix tier.
  // Fix tiers ($199 scan_fix / $399 nuclear) get full detail — the fix PR
  // is the deliverable and requires the exact location.
  const isFixTier = tier === "scan_fix" || tier === "nuclear";
  const redactedModules = isFixTier
    ? finalModules
    : finalModules.map((m) => ({
        ...m,
        details: (m.details || []).map((d: string) => {
          // Strip "path/to/file.ts:42 — " and "path/to/file.ts — " prefixes.
          const stripped = d.replace(/^(?:error|warn(?:ing)?|info)\s*:\s*/i, "").trim();
          return stripped.replace(/^[A-Za-z0-9_./@\-+]+?\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?\s*[-—:]\s*/, "");
        }),
      }));

  return NextResponse.json({
    status: result.error ? "failed" : "complete",
    modules: redactedModules,
    totalModules: finalModules.length,
    completedModules: finalModules.length,
    totalIssues: finalTotalIssues,
    totalFixed: 0,
    duration: result.duration,
    repoUrl,
    tier,
    admin: isAdmin,
    authSource: result.authSource,
    error: result.error,
    fixableIssues,
    // Phase 1.2b activation: per-module findings map so the fix API can
    // run the cross-scanner re-validation gate without a separate fetch.
    // The gate diffs post-fix findings against this baseline to detect
    // new regressions introduced by a fix.
    findingsByModule: Object.fromEntries(
      finalModules
        .filter((m) => Array.isArray(m.details) && (m.details as string[]).length > 0)
        .map((m) => [m.name, m.details as string[]])
    ),
    // Honest disclosure of what the brain hid / softened. Operator
    // dashboard (5.2.4) consumes the same shape via /admin/learning.
    confidenceAdjustments: {
      suppressed: confidenceAdjustments.suppressedCount,
      downgraded: confidenceAdjustments.downgradedCount,
    },
  });
}
